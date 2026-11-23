// 取证报告页: 单事件详情 + 轨迹叠加图 + 标定信息, 可打印
import { store } from '../store';
import { gridLines } from '../calib/geometry';

export function reportPage(root: HTMLElement) {
  const id = location.hash.split('/')[2] || '';
  const events = store.events();
  const ev = events.find(e => e.id === id) || events[events.length - 1];

  if (!ev) {
    root.innerHTML = `<h2>取证报告</h2><div class="panel"><p class="hint">暂无事件。请先在「视频分析」页分析录像并保存事件。</p></div>`;
    return;
  }
  const calib = store.getCalibration(ev.calibrationId);

  root.innerHTML = `
    <h2 class="noprint">取证报告</h2>
    <div class="panel row noprint">
      <label>选择事件</label>
      <select id="selEv" style="width:320px">
        ${events.map(e => `<option value="${e.id}" ${e.id === ev.id ? 'selected' : ''}>${e.label} · ${e.videoName} · ${fmtT(e.videoTime)}</option>`).join('')}
      </select>
      <button id="bPrint">打印 / 另存 PDF</button>
      <button class="ghost" id="bJson">导出证据 JSON</button>
    </div>
    <div class="panel" id="report">
      <h2 style="text-align:center; margin-bottom:4px">高空抛物事件取证报告</h2>
      <p style="text-align:center" class="hint">生成时间: ${new Date().toLocaleString('zh-CN')}</p>
      <h3>一、事件信息</h3>
      <div class="kv">
        <b>涉事户号</b><span style="font-size:18px; font-weight:700">${ev.label} (${ev.floor} 层 ${ev.unit} 户)</span>
        <b>录像文件</b><span>${ev.videoName}</span>
        <b>抛出时刻(录像内)</b><span>${fmtT(ev.videoTime)}</span>
        <b>检测置信度</b><span>${(ev.confidence * 100).toFixed(0)}%</span>
        <b>物体特征推测</b><span>${ev.objectGuess}</span>
        <b>轨迹采样点</b><span>${ev.trajectory.length} 个</span>
      </div>
      <h3>二、楼栋标定信息</h3>
      <div class="kv">
        <b>标定名称</b><span>${calib?.name ?? '未知(标定已删除)'}</span>
        <b>网格</b><span>${calib ? `${calib.floors} 层 × ${calib.units} 户, 起始楼层 ${calib.startFloor}` : '-'}</span>
      </div>
      <h3>三、轨迹回溯图</h3>
      <canvas id="cvRep" class="view" width="860" height="484" style="border:1px solid var(--line)"></canvas>
      <p class="hint">红线为下落物体轨迹, 红点为沿抛物线回推的抛出位置, 蓝格为标定的楼层/户号网格。</p>
      <h3>四、事件截图</h3>
      <img src="${ev.thumbnail}" style="max-width:480px; border:1px solid var(--line); border-radius:6px" alt="事件截图">
      <h3>五、说明</h3>
      <p class="hint" style="max-width:720px">
        本报告由高空抛物分析系统自动生成: 系统对监控画面做运动检测, 跟踪下落目标并拟合抛物线轨迹,
        沿轨迹向过去回溯至楼面网格, 得到抛出楼层与户号。楼层判定误差标称不超过一层, 户号判定受标定精度与摄像头角度影响,
        建议结合人工复核与上门核实使用, 不作为唯一证据。
      </p>
    </div>`;

  const cv = root.querySelector<HTMLCanvasElement>('#cvRep')!;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#10151c';
  ctx.fillRect(0, 0, cv.width, cv.height);
  // 标定参考图 + 网格 + 轨迹
  const drawAll = (img?: HTMLImageElement) => {
    if (img) ctx.drawImage(img, 0, 0, cv.width, cv.height);
    if (calib) {
      const { rows, cols } = gridLines(calib);
      ctx.strokeStyle = 'rgba(77,163,255,.5)';
      ctx.lineWidth = 1;
      for (const [a, b] of rows.concat(cols)) {
        ctx.beginPath();
        ctx.moveTo(a.x * cv.width, a.y * cv.height);
        ctx.lineTo(b.x * cv.width, b.y * cv.height);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = '#ff5252';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ev.trajectory.forEach((p, i) => i ? ctx.lineTo(p.x * cv.width, p.y * cv.height) : ctx.moveTo(p.x * cv.width, p.y * cv.height));
    ctx.stroke();
    ctx.fillStyle = '#ff5252';
    ctx.beginPath();
    ctx.arc(ev.throwPoint.x * cv.width, ev.throwPoint.y * cv.height, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(ev.label, ev.throwPoint.x * cv.width + 12, ev.throwPoint.y * cv.height - 8);
  };
  if (calib?.imageDataUrl) {
    const img = new Image();
    img.onload = () => drawAll(img);
    img.src = calib.imageDataUrl;
  } else drawAll();

  root.querySelector('#selEv')!.addEventListener('change', e => {
    location.hash = '#/report/' + (e.target as HTMLSelectElement).value;
  });
  root.querySelector('#bPrint')!.addEventListener('click', () => window.print());
  root.querySelector('#bJson')!.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ event: ev, calibration: calib }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `取证_${ev.label}_${fmtT(ev.videoTime).replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function fmtT(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
