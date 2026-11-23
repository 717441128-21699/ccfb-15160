// 视频分析页: 导入监控录像 -> WebGL2 运动检测 -> 跟踪 -> 分类 -> 抛物线回推 -> 楼层/户号
import type { Calibration, GroundTruth, ThrowEvent, TrackPoint, AccuracyReport } from '../types';
import { unitLabel } from '../types';
import { MotionDetector } from '../gl/MotionDetector';
import { extractBlobs } from '../detect/blobs';
import { Tracker } from '../detect/tracker';
import { extractFeatures, classifyTrack, guessObject } from '../detect/classify';
import { fitTrajectory, backProject, confidence } from '../detect/trajectory';
import { cellAt, gridLines } from '../calib/geometry';
import { store, uid } from '../store';

export function analysisPage(root: HTMLElement) {
  const calibs = store.calibrations();
  let videoFile: File | null = null;
  let gt: GroundTruth | null = null;
  let running = false;
  let stopFlag = false;
  const found: ThrowEvent[] = [];

  root.innerHTML = `
    <h2>视频分析</h2>
    <div class="panel row">
      <label class="filebtn"><button class="ghost" type="button">选择监控录像</button><input type="file" id="fVid" accept="video/*"></label>
      <span id="vidName" class="hint">未选择</span>
      <label class="filebtn"><button class="ghost" type="button">加载真值JSON(可选, 用于精度验证)</button><input type="file" id="fGt" accept=".json"></label>
      <span id="gtName" class="hint"></span>
    </div>
    <div class="panel row">
      <div class="col"><label>楼栋标定</label>
        <select id="selCal" style="width:180px">${calibs.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select></div>
      <div class="col"><label>处理分辨率</label>
        <select id="selRes"><option value="640x360">640×360 (推荐)</option><option value="480x270">480×270 (更快)</option><option value="960x540">960×540 (更准)</option></select></div>
      <div class="col"><label>检测灵敏度 <span id="thVal">0.09</span></label>
        <input type="range" id="rgTh" min="0.03" max="0.25" step="0.01" value="0.09"></div>
      <div class="col"><label>分析速度</label>
        <select id="selSpeed"><option value="4">4× (稳妥)</option><option value="8" selected>8×</option><option value="16">16× (最快)</option><option value="1">1× (逐帧最准)</option></select></div>
      <div class="col"><label>&nbsp;</label><label style="color:var(--fg)"><input type="checkbox" id="ckNight"> 夜间红外画面</label></div>
      <div class="col"><label>&nbsp;</label><button id="bRun">开始分析</button></div>
      <div class="col"><label>&nbsp;</label><button id="bStop" class="danger" disabled>停止</button></div>
    </div>
    <div class="panel">
      <div class="row" style="align-items:center">
        <div class="progress" style="flex:1"><div id="bar"></div></div>
        <span id="stat" class="hint">就绪</span>
      </div>
      <div class="row" style="margin-top:10px">
        <canvas id="cv" class="view" width="768" height="432" style="flex:1; min-width:380px"></canvas>
        <div class="col" style="width:300px">
          <h3 style="margin-top:0">检出事件 <span id="evCount" class="badge">0</span></h3>
          <div id="evList" style="max-height:360px; overflow:auto"></div>
        </div>
      </div>
    </div>
    <div class="panel" id="accPanel" style="display:none">
      <h3 style="margin-top:0">精度验证(与真值比对)</h3>
      <div id="accBody"></div>
    </div>
    <div class="panel row" id="savePanel" style="display:none">
      <button id="bSave">保存事件到事件列表</button>
      <span class="hint">保存后可在「事件列表」与「取证报告」中查看</span>
    </div>`;

  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const cv = $('#cv') as HTMLCanvasElement;
  const ctx = cv.getContext('2d')!;

  $('#fVid').addEventListener('change', e => {
    videoFile = (e.target as HTMLInputElement).files?.[0] || null;
    $('#vidName').textContent = videoFile ? `${videoFile.name} (${(videoFile.size / 1048576).toFixed(1)} MB)` : '未选择';
  });
  $('#fGt').addEventListener('change', e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { gt = JSON.parse(rd.result as string); $('#gtName').textContent = `真值: ${gt!.events.length} 个事件`; }
      catch { $('#gtName').textContent = '真值文件解析失败'; }
    };
    rd.readAsText(f);
  });
  $('#rgTh').addEventListener('input', e => { $('#thVal').textContent = (e.target as HTMLInputElement).value; });

  function addEvent(ev: ThrowEvent) {
    // 去重: 2.5 秒内同户的事件合并(取置信度高的)
    const dup = found.find(e => Math.abs(e.videoTime - ev.videoTime) < 2.5 && e.floor === ev.floor && e.unit === ev.unit);
    if (dup) {
      if (ev.confidence > dup.confidence) Object.assign(dup, ev, { id: dup.id });
      return;
    }
    found.push(ev);
    found.sort((a, b) => a.videoTime - b.videoTime);
    $('#evCount').textContent = String(found.length);
    const list = $('#evList');
    list.innerHTML = '';
    for (const e of found) {
      const d = document.createElement('div');
      d.className = 'row';
      d.style.cssText = 'align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid var(--line)';
      const cls = e.confidence >= 0.7 ? 'ok' : e.confidence >= 0.45 ? 'warn' : 'bad';
      d.innerHTML = `<span class="badge ${cls}">${(e.confidence * 100).toFixed(0)}%</span>
        <span style="flex:1">${fmtT(e.videoTime)} · <b>${e.label}</b> (${e.floor}层${e.unit}户)</span>
        <span class="hint">${e.objectGuess}</span>`;
      list.appendChild(d);
    }
  }

  async function run() {
    if (!videoFile) { alert('请先选择监控录像'); return; }
    const calib = store.getCalibration(($('#selCal') as HTMLSelectElement).value) as Calibration | undefined;
    if (!calib) { alert('请先在「楼栋标定」页创建标定'); return; }
    const [pw, ph] = ($('#selRes') as HTMLSelectElement).value.split('x').map(Number);
    const speed = +($('#selSpeed') as HTMLSelectElement).value;
    const night = ($('#ckNight') as HTMLInputElement).checked;
    const th = +($('#rgTh') as HTMLInputElement).value;

    running = true; stopFlag = false;
    found.length = 0;
    $('#evList').innerHTML = ''; $('#evCount').textContent = '0';
    ($('#bRun') as HTMLButtonElement).disabled = true;
    ($('#bStop') as HTMLButtonElement).disabled = false;
    ($('#accPanel') as HTMLElement).style.display = 'none';
    ($('#savePanel') as HTMLElement).style.display = 'none';

    const detector = new MotionDetector(pw, ph, { threshold: th, night });
    const tracker = new Tracker();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.src = URL.createObjectURL(videoFile);
    await new Promise<void>((res, rej) => { video.onloadeddata = () => res(); video.onerror = () => rej(new Error('视频解码失败')); });
    video.playbackRate = speed;

    const minArea = Math.max(4, Math.round(pw * ph * 0.00003));
    const maxArea = Math.round(pw * ph * 0.05);
    let frames = 0;
    const t0wall = performance.now();

    const handleTrack = (points: TrackPoint[]) => {
      const feat = extractFeatures(points);
      const cls = classifyTrack(feat);
      if (cls !== 'fall') return;
      const fit = fitTrajectory(points);
      if (!fit) return;
      const back = backProject(fit, calib);
      if (!back) return;
      const cell = cellAt(calib, back.throwPoint);
      if (!cell) return;
      addEvent({
        id: uid(), videoName: videoFile!.name,
        videoTime: back.throwTime, wallTime: Date.now(),
        floor: cell.floor, unit: cell.unit,
        label: unitLabel(calib, cell.floor, cell.unit),
        confidence: confidence(fit, back),
        throwPoint: back.throwPoint,
        trajectory: points,
        thumbnail: makeThumb(video, calib, points, back.throwPoint),
        calibrationId: calib.id,
        objectGuess: guessObject(feat),
      });
    };

    const processFrame = () => {
      const mask = detector.process(video);
      frames++;
      if (frames < 3) return; // 前两帧背景未建立, 跳过
      const blobs = extractBlobs(mask, pw, ph, minArea, maxArea);
      const finished = tracker.update(blobs, video.currentTime, pw, ph);
      for (const tr of finished) handleTrack(tr.points);
      drawOverlay(video, calib, blobs, pw, ph);
    };

    // 主循环: requestVideoFrameCallback 驱动
    await new Promise<void>(resolve => {
      const onEnd = () => { resolve(); };
      video.addEventListener('ended', onEnd, { once: true });
      const tick = () => {
        if (stopFlag) { video.pause(); resolve(); return; }
        if (video.readyState >= 2 && !video.paused && !video.ended) {
          try { processFrame(); } catch (err) { console.error(err); }
        }
        const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
        ($('#bar') as HTMLElement).style.width = pct.toFixed(1) + '%';
        const elapsed = (performance.now() - t0wall) / 1000;
        $('#stat').textContent =
          `${fmtT(video.currentTime)} / ${fmtT(video.duration)} · ${frames} 帧 · ` +
          `${(frames / Math.max(0.1, elapsed)).toFixed(0)} 帧/秒 · 事件 ${found.length}`;
        if (!video.ended) (video as any).requestVideoFrameCallback ? (video as any).requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
      };
      video.play().then(() => tick()).catch(err => { alert('播放失败: ' + err); resolve(); });
    });

    for (const tr of tracker.flush()) handleTrack(tr.points);
    URL.revokeObjectURL(video.src);
    running = false;
    ($('#bRun') as HTMLButtonElement).disabled = false;
    ($('#bStop') as HTMLButtonElement).disabled = true;
    const elapsed = (performance.now() - t0wall) / 1000;
    $('#stat').textContent = `完成: ${frames} 帧, 用时 ${elapsed.toFixed(1)}s (视频时长 ${video.duration.toFixed(0)}s, 倍速 ${(video.duration / Math.max(0.1, elapsed)).toFixed(1)}×), 检出 ${found.length} 个事件`;
    if (found.length) ($('#savePanel') as HTMLElement).style.display = '';
    if (gt) showAccuracy(calib);
  }

  function drawOverlay(video: HTMLVideoElement, calib: Calibration, blobs: { minX: number; minY: number; maxX: number; maxY: number }[], pw: number, ph: number) {
    const dw = cv.width, dh = cv.height;
    ctx.drawImage(video, 0, 0, dw, dh);
    // 标定网格
    const { rows, cols } = gridLines(calib);
    ctx.strokeStyle = 'rgba(77,163,255,.35)';
    ctx.lineWidth = 1;
    for (const [a, b] of rows.concat(cols)) {
      ctx.beginPath(); ctx.moveTo(a.x * dw, a.y * dh); ctx.lineTo(b.x * dw, b.y * dh); ctx.stroke();
    }
    // 运动目标框
    ctx.strokeStyle = '#4caf7d';
    for (const b of blobs) {
      ctx.strokeRect(b.minX / pw * dw, b.minY / ph * dh, (b.maxX - b.minX) / pw * dw, (b.maxY - b.minY) / ph * dh);
    }
    // 已确认事件抛出点
    for (const e of found) {
      ctx.strokeStyle = 'rgba(224,92,92,.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      e.trajectory.forEach((p, i) => i ? ctx.lineTo(p.x * dw, p.y * dh) : ctx.moveTo(p.x * dw, p.y * dh));
      ctx.stroke();
      ctx.fillStyle = '#e05c5c';
      ctx.beginPath(); ctx.arc(e.throwPoint.x * dw, e.throwPoint.y * dh, 5, 0, Math.PI * 2); ctx.fill();
      ctx.font = '13px sans-serif';
      ctx.fillText(e.label, e.throwPoint.x * dw + 8, e.throwPoint.y * dh - 6);
    }
  }

  function makeThumb(video: HTMLVideoElement, calib: Calibration, traj: TrackPoint[], tp: { x: number; y: number }): string {
    const c = document.createElement('canvas');
    c.width = 480; c.height = 270;
    const g = c.getContext('2d')!;
    g.drawImage(video, 0, 0, 480, 270);
    g.strokeStyle = '#ff5252'; g.lineWidth = 2;
    g.beginPath();
    traj.forEach((p, i) => i ? g.lineTo(p.x * 480, p.y * 270) : g.moveTo(p.x * 480, p.y * 270));
    g.stroke();
    g.fillStyle = '#ff5252';
    g.beginPath(); g.arc(tp.x * 480, tp.y * 270, 5, 0, Math.PI * 2); g.fill();
    return c.toDataURL('image/jpeg', 0.7);
  }

  function showAccuracy(calib: Calibration) {
    if (!gt) return;
    const rep: AccuracyReport = { matched: 0, missed: 0, falseAlarms: 0, floorExact: 0, floorWithin1: 0, unitCorrect: 0 };
    const used = new Set<number>();
    const rowsHtml: string[] = [];
    for (const g of gt.events) {
      let best = -1, bestDt = Infinity;
      found.forEach((e, i) => {
        if (used.has(i)) return;
        const dt = Math.abs(e.videoTime - g.t);
        if (dt < 3 && dt < bestDt) { best = i; bestDt = dt; }
      });
      if (best < 0) {
        rep.missed++;
        rowsHtml.push(`<tr><td>${fmtT(g.t)}</td><td>${unitLabel(calib, g.floor, g.unit)}</td><td colspan="3" class="bad" style="color:var(--bad)">漏检</td></tr>`);
        continue;
      }
      used.add(best);
      rep.matched++;
      const e = found[best];
      const fErr = Math.abs(e.floor - g.floor);
      if (fErr === 0) rep.floorExact++;
      if (fErr <= 1) rep.floorWithin1++;
      const unitOk = e.floor === g.floor && e.unit === g.unit;
      if (unitOk) rep.unitCorrect++;
      rowsHtml.push(`<tr><td>${fmtT(g.t)}</td><td>${unitLabel(calib, g.floor, g.unit)}</td>
        <td>${e.label}</td><td>${fErr === 0 ? '✓' : `差${fErr}层`}</td>
        <td style="color:${unitOk ? 'var(--ok)' : 'var(--bad)'}">${unitOk ? '✓' : '✗'}</td></tr>`);
    }
    rep.falseAlarms = found.length - used.size;
    const pct = (a: number, b: number) => b ? (a / b * 100).toFixed(1) + '%' : '-';
    $('#accBody').innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <span class="badge">检出 ${rep.matched}/${gt.events.length}</span>
        <span class="badge ${rep.missed ? 'bad' : 'ok'}">漏检 ${rep.missed}</span>
        <span class="badge ${rep.falseAlarms ? 'warn' : 'ok'}">误报 ${rep.falseAlarms}</span>
        <span class="badge ${rep.floorWithin1 === rep.matched ? 'ok' : 'warn'}">楼层误差≤1层: ${pct(rep.floorWithin1, rep.matched)}</span>
        <span class="badge ${rep.matched && rep.unitCorrect / rep.matched >= 0.9 ? 'ok' : 'warn'}">户号正确率: ${pct(rep.unitCorrect, rep.matched)}</span>
      </div>
      <table><tr><th>时间</th><th>真实户</th><th>检出户</th><th>楼层</th><th>户号</th></tr>${rowsHtml.join('')}</table>`;
    ($('#accPanel') as HTMLElement).style.display = '';
  }

  $('#bRun').addEventListener('click', () => { if (!running) run().catch(e => { alert('分析出错: ' + e.message); console.error(e); }); });
  $('#bStop').addEventListener('click', () => { stopFlag = true; });
  $('#bSave').addEventListener('click', () => {
    store.saveEvents(found);
    alert(`已保存 ${found.length} 个事件`);
    ($('#savePanel') as HTMLElement).style.display = 'none';
  });

  if (!calibs.length) {
    $('#stat').textContent = '提示: 还没有楼栋标定, 请先到「楼栋标定」页创建, 或在「测试视频合成」页生成带标定的测试视频。';
  }
}

function fmtT(sec: number): string {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
