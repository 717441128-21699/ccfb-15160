// 测试视频合成页: 生成带真值的模拟监控录像(多种抛掷物 × 风速 × 干扰 × 昼夜)
// 输出: 1) webm 录像  2) 真值 groundtruth.json  3) 配套标定 calibration.json
import type { Calibration, GroundTruth, GroundTruthEvent } from '../types';
import { bilinear } from '../calib/geometry';
import { uid } from '../store';

type ObjType = 'bottle' | 'bag' | 'box' | 'paper';
const OBJ_CFG: Record<ObjType, { size: number; windK: number; vTerm: number; flutter: number; label: string }> = {
  bottle: { size: 0.006, windK: 0.15, vTerm: 0.9, flutter: 0, label: '瓶罐' },
  bag: { size: 0.012, windK: 0.6, vTerm: 0.45, flutter: 0.15, label: '垃圾袋' },
  box: { size: 0.018, windK: 1.0, vTerm: 0.35, flutter: 0.3, label: '纸箱' },
  paper: { size: 0.010, windK: 1.6, vTerm: 0.22, flutter: 0.8, label: '纸张' },
};
const G = 0.21; // 归一化重力加速度 (≈9.8m/s², 楼高~47m 对应 1 归一化单位)

interface SimObj {
  kind: 'throw' | 'leaf' | 'bird' | 'rain';
  type?: ObjType;
  x: number; y: number; vx: number; vy: number;
  t0: number; phase: number; size: number;
  windK: number; vTerm: number; flutter: number;
  dead: boolean;
}

export function synthPage(root: HTMLElement) {
  root.innerHTML = `
    <h2>测试视频合成</h2>
    <div class="panel">
      <p class="hint">按设定合成一段仰拍监控录像, 内含若干起高空抛物(随机楼层/户号), 并叠加风吹树叶、飞鸟、雨滴等干扰。
      生成后自动下载 <b>录像 webm</b>、<b>真值 JSON</b>、<b>配套标定 JSON</b> 三个文件, 可直接用于「视频分析」页的精度验证。</p>
      <div class="row">
        <div class="col"><label>时长(秒)</label><select id="sDur"><option>30</option><option selected>60</option><option>120</option></select></div>
        <div class="col"><label>分辨率</label><select id="sRes"><option value="1280x720" selected>1280×720</option><option value="1920x1080">1920×1080</option></select></div>
        <div class="col"><label>楼层×户数</label><select id="sGrid"><option value="15x4" selected>15层 × 4户</option><option value="10x3">10层 × 3户</option><option value="25x6">25层 × 6户</option></select></div>
        <div class="col"><label>抛物事件数</label><input type="number" id="sEvents" value="8" min="1" max="40"></div>
        <div class="col"><label>抛掷物类型</label>
          <div id="sTypes" style="display:flex; gap:8px; padding-top:4px">
            <label><input type="checkbox" value="bottle" checked>瓶罐</label>
            <label><input type="checkbox" value="bag" checked>垃圾袋</label>
            <label><input type="checkbox" value="box" checked>纸箱</label>
            <label><input type="checkbox" value="paper">纸张</label>
          </div></div>
        <div class="col"><label>风速</label><select id="sWind">
          <option value="rand" selected>随机 0~8 m/s</option><option value="0">无风</option><option value="3">3 m/s</option><option value="5">5 m/s</option><option value="8">8 m/s(大风)</option></select></div>
        <div class="col"><label>干扰强度</label><select id="sDist"><option value="1" selected>正常(树叶+鸟)</option><option value="0">无干扰</option><option value="2">强(大量树叶+鸟)</option></select></div>
        <div class="col"><label>&nbsp;</label><label style="color:var(--fg)"><input type="checkbox" id="sRain"> 下雨</label></div>
        <div class="col"><label>&nbsp;</label><label style="color:var(--fg)"><input type="checkbox" id="sNight"> 夜间红外</label></div>
      </div>
      <div class="row" style="margin-top:12px">
        <button id="bGo">开始合成</button>
        <button id="bCancel" class="danger" disabled>取消</button>
        <div class="progress" style="flex:1; align-self:center"><div id="bar"></div></div>
        <span id="stat" class="hint">就绪</span>
      </div>
    </div>
    <div class="panel"><canvas id="cv" class="view" width="960" height="540"></canvas>
      <p class="hint">合成为实时渲染(30fps), 时长多久就录多久。画面即录像内容预览。</p></div>`;

  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const cv = $('#cv') as HTMLCanvasElement;
  let cancel = false;

  $('#bGo').addEventListener('click', async () => {
    cancel = false;
    ($('#bGo') as HTMLButtonElement).disabled = true;
    ($('#bCancel') as HTMLButtonElement).disabled = false;
    try { await generate(); } catch (e) { console.error(e); $('#stat').textContent = '合成失败: ' + (e as Error).message; }
    ($('#bGo') as HTMLButtonElement).disabled = false;
    ($('#bCancel') as HTMLButtonElement).disabled = true;
  });
  $('#bCancel').addEventListener('click', () => { cancel = true; });

  async function generate() {
    const dur = +($('#sDur') as HTMLSelectElement).value;
    const [W, H] = ($('#sRes') as HTMLSelectElement).value.split('x').map(Number);
    const [floors, units] = ($('#sGrid') as HTMLSelectElement).value.split('x').map(Number);
    const nEvents = +($('#sEvents') as HTMLInputElement).value;
    const types = [...root.querySelectorAll<HTMLInputElement>('#sTypes input:checked')].map(i => i.value as ObjType);
    if (!types.length) { alert('至少选一种抛掷物'); return; }
    const windSel = ($('#sWind') as HTMLSelectElement).value;
    const distLevel = +($('#sDist') as HTMLSelectElement).value;
    const rain = ($('#sRain') as HTMLInputElement).checked;
    const night = ($('#sNight') as HTMLInputElement).checked;

    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d')!;
    // 楼面四边形(轻微透视, 模拟仰拍)
    const calib: Calibration = {
      id: uid(), name: `合成楼栋_${floors}层x${units}户`, createdAt: Date.now(),
      imageDataUrl: '', imgW: W, imgH: H,
      quad: [{ x: 0.28, y: 0.03 }, { x: 0.72, y: 0.03 }, { x: 0.84, y: 0.97 }, { x: 0.16, y: 0.97 }],
      floors, units, startFloor: 2, unitOrder: 'ltr',
    };
    // 事件计划
    const gt: GroundTruthEvent[] = [];
    const throws: { t: number; row: number; col: number; type: ObjType; wind: number }[] = [];
    for (let i = 0; i < nEvents; i++) {
      const t = 2 + Math.random() * (dur - 8);
      const row = Math.floor(Math.random() * (floors - 2)); // 不从最底两层抛(保证下落段在画面内)
      const col = Math.floor(Math.random() * units);
      const type = types[Math.floor(Math.random() * types.length)];
      const wind = windSel === 'rand' ? Math.round(Math.random() * 8) : +windSel;
      throws.push({ t, row, col, type, wind });
      gt.push({ t: Math.round(t * 10) / 10, floor: calib.startFloor + (floors - 1 - row), unit: col + 1, object: OBJ_CFG[type].label, wind });
    }
    throws.sort((a, b) => a.t - b.t);
    gt.sort((a, b) => a.t - b.t);

    const objs: SimObj[] = [];
    let throwIdx = 0;
    let birdTimer = 3, leafTimer = 0;
    const FPS = 30;

    // 录制
    const stream = cv.captureStream(FPS);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const recDone = new Promise<void>(r => { rec.onstop = () => r(); });
    rec.start(500);

    const t0 = performance.now();
    let simT = 0;
    let frame = 0;
    const litWindows = new Set<string>();
    for (let i = 0; i < floors * units * 0.25; i++) litWindows.add(`${Math.floor(Math.random() * floors)}_${Math.floor(Math.random() * units)}`);

    while (simT < dur && !cancel) {
      const dt = 1 / FPS;
      simT = frame * dt;
      // 生成抛物事件
      while (throwIdx < throws.length && throws[throwIdx].t <= simT) {
        const th = throws[throwIdx++];
        const c = OBJ_CFG[th.type];
        const p = bilinear(calib.quad, (th.col + 0.5) / units, (th.row + 0.5) / floors);
        objs.push({
          kind: 'throw', type: th.type, x: p.x, y: p.y,
          vx: (Math.random() - 0.5) * 0.04, vy: 0.01,
          t0: simT, phase: Math.random() * 6.28, size: c.size,
          windK: c.windK * th.wind / 50, vTerm: c.vTerm, flutter: c.flutter, dead: false,
        });
      }
      // 干扰: 树叶 / 鸟 / 雨
      if (distLevel > 0) {
        leafTimer -= dt;
        if (leafTimer <= 0) {
          leafTimer = (distLevel === 2 ? 0.5 : 1.5) + Math.random() * 2;
          objs.push({ kind: 'leaf', x: Math.random(), y: -0.02, vx: 0, vy: 0.06 + Math.random() * 0.06, t0: simT, phase: Math.random() * 6.28, size: 0.004, windK: 0.002, vTerm: 0.15, flutter: 1, dead: false });
        }
        birdTimer -= dt;
        if (birdTimer <= 0) {
          birdTimer = (distLevel === 2 ? 4 : 9) + Math.random() * 8;
          const dir = Math.random() < 0.5 ? 1 : -1;
          objs.push({ kind: 'bird', x: dir > 0 ? -0.05 : 1.05, y: 0.1 + Math.random() * 0.5, vx: dir * (0.15 + Math.random() * 0.15), vy: 0, t0: simT, phase: Math.random() * 6.28, size: 0.008, windK: 0, vTerm: 0, flutter: 0, dead: false });
        }
      }
      if (rain) {
        for (let i = 0; i < 6; i++)
          objs.push({ kind: 'rain', x: Math.random(), y: -0.02, vx: 0.01, vy: 1.0 + Math.random() * 0.5, t0: simT, phase: 0, size: 0.002, windK: 0, vTerm: 2, flutter: 0, dead: false });
      }
      // 更新
      for (const o of objs) {
        const age = simT - o.t0;
        if (o.kind === 'throw') {
          o.vy = Math.min(o.vy + G * dt, o.vTerm);
          o.vx += (o.windK - o.vx) * dt * 1.5;
          o.x += (o.vx + Math.sin(age * 5 + o.phase) * 0.01 * o.flutter) * dt;
          o.y += o.vy * dt;
        } else if (o.kind === 'leaf') {
          o.x += (Math.sin(age * 3 + o.phase) * 0.06 + o.windK) * dt;
          o.y += o.vy * dt;
        } else if (o.kind === 'bird') {
          o.x += o.vx * dt;
          o.y += Math.sin(age * 8 + o.phase) * 0.01 * dt * 10;
        } else {
          o.x += o.vx * dt; o.y += o.vy * dt;
        }
        if (o.y > 1.05 || o.x < -0.1 || o.x > 1.1) o.dead = true;
      }
      for (let i = objs.length - 1; i >= 0; i--) if (objs[i].dead) objs.splice(i, 1);
      // 绘制
      drawScene(ctx, W, H, calib, litWindows, objs, simT, night, rain);
      frame++;
      ($('#bar') as HTMLElement).style.width = (simT / dur * 100).toFixed(1) + '%';
      $('#stat').textContent = `合成中 ${simT.toFixed(1)}s / ${dur}s`;
      // 实时等待
      const target = t0 + frame * (1000 / FPS);
      const wait = target - performance.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      else await new Promise(r => setTimeout(r, 0));
    }
    rec.stop();
    await recDone;
    if (cancel) { $('#stat').textContent = '已取消'; return; }

    // 标定参考图: 用最后一帧
    calib.imageDataUrl = cv.toDataURL('image/jpeg', 0.8);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    download(new Blob(chunks, { type: 'video/webm' }), `合成监控_${stamp}.webm`);
    download(new Blob([JSON.stringify({ video: `合成监控_${stamp}.webm`, events: gt } satisfies GroundTruth, null, 2)], { type: 'application/json' }), `真值_${stamp}.json`);
    download(new Blob([JSON.stringify(calib, null, 2)], { type: 'application/json' }), `标定_${stamp}.json`);
    $('#stat').textContent = `完成: ${frame} 帧, ${gt.length} 个抛物事件, 已下载 3 个文件`;
  }
}

function drawScene(ctx: CanvasRenderingContext2D, W: number, H: number, calib: Calibration,
  litWindows: Set<string>, objs: SimObj[], t: number, night: boolean, rain: boolean) {
  // 天空
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  if (night) { sky.addColorStop(0, '#05070c'); sky.addColorStop(1, '#0c1018'); }
  else { sky.addColorStop(0, '#7ea8d0'); sky.addColorStop(1, '#c8d8e8'); }
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // 楼面
  const q = calib.quad;
  ctx.beginPath();
  ctx.moveTo(q[0].x * W, q[0].y * H); ctx.lineTo(q[1].x * W, q[1].y * H);
  ctx.lineTo(q[2].x * W, q[2].y * H); ctx.lineTo(q[3].x * W, q[3].y * H);
  ctx.closePath();
  ctx.fillStyle = night ? '#1a1d24' : '#9a8f80';
  ctx.fill();
  // 窗户
  for (let r = 0; r < calib.floors; r++) {
    for (let c = 0; c < calib.units; c++) {
      const p = bilinear(calib.quad, (c + 0.5) / calib.units, (r + 0.5) / calib.floors);
      const ww = W * 0.028, wh = H * 0.7 / calib.floors * 0.55;
      const lit = litWindows.has(`${r}_${c}`);
      ctx.fillStyle = night ? (lit ? '#d8c890' : '#23262e') : (lit ? '#5a6a7a' : '#3d4a5a');
      ctx.fillRect(p.x * W - ww / 2, p.y * H - wh / 2, ww, wh);
    }
  }
  // 地面
  ctx.fillStyle = night ? '#0a0c10' : '#5a6a55';
  ctx.fillRect(0, H * 0.97, W, H * 0.03);
  // 目标
  for (const o of objs) {
    const x = o.x * W, y = o.y * H;
    const s = o.size * W;
    if (o.kind === 'rain') {
      ctx.strokeStyle = night ? 'rgba(200,210,220,.5)' : 'rgba(180,200,220,.45)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - o.vx * 15, y - o.vy * 15); ctx.stroke();
    } else if (o.kind === 'bird') {
      const flap = Math.abs(Math.sin(t * 10 + o.phase));
      ctx.fillStyle = night ? '#9aa2ae' : '#2c2c30';
      ctx.beginPath();
      ctx.ellipse(x, y, s, s * (0.3 + flap * 0.5), 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (o.kind === 'leaf') {
      ctx.fillStyle = night ? '#8a928a' : '#6a8a4a';
      ctx.save(); ctx.translate(x, y); ctx.rotate(t * 3 + o.phase);
      ctx.fillRect(-s / 2, -s / 4, s, s / 2);
      ctx.restore();
    } else {
      // 抛掷物
      ctx.fillStyle = night ? '#c8ccd4' : '#3a3f4a';
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.5, s), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 夜间红外效果: 噪声 + 暗角
  if (night) {
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    for (let i = 0; i < 40; i++) ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.85);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }
  if (rain) {
    ctx.fillStyle = 'rgba(120,140,160,.06)';
    ctx.fillRect(0, 0, W, H);
  }
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
