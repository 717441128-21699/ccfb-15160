// 楼栋标定页: 参考图上拖拽四边形 + 楼层/户数 -> 窗户阳台网格
import type { Calibration, Pt, Quad } from '../types';
import { gridLines, cellCenter } from '../calib/geometry';
import { store, uid } from '../store';
import { unitLabel } from '../types';

export function calibrationPage(root: HTMLElement) {
  let img: HTMLImageElement | null = null;
  let quad: Quad = [
    { x: 0.2, y: 0.05 }, { x: 0.8, y: 0.05 },
    { x: 0.9, y: 0.95 }, { x: 0.1, y: 0.95 },
  ];
  let floors = 15, units = 4, startFloor = 2, unitOrder: 'ltr' | 'rtl' = 'ltr';
  let calibName = '1号楼';
  let editingId: string | null = null;
  let dragIdx = -1;

  root.innerHTML = `
    <h2>楼栋标定</h2>
    <div class="panel">
      <div class="row">
        <label class="filebtn"><button class="ghost" type="button">导入参考图(照片/截图)</button><input type="file" id="fImg" accept="image/*"></label>
        <label class="filebtn"><button class="ghost" type="button">从视频抓帧</button><input type="file" id="fVid" accept="video/*"></label>
        <label class="filebtn"><button class="ghost" type="button">导入标定JSON</button><input type="file" id="fJson" accept=".json"></label>
        <span class="hint">建议: 直接用监控摄像头拍的一张正视楼栋照片, 或从监控视频中抓一帧。</span>
      </div>
    </div>
    <div class="row">
      <div class="panel" style="flex:1; min-width:420px">
        <canvas id="cv" class="view" width="960" height="540" style="cursor:crosshair"></canvas>
        <p class="hint">拖动四个角点使四边形贴合楼面(窗户/阳台区域), 网格线会自动按楼层和户数划分。</p>
      </div>
      <div class="panel col" style="width:280px">
        <div class="col"><label>标定名称</label><input type="text" id="iName" value="${calibName}"></div>
        <div class="col"><label>楼层数</label><input type="number" id="iFloors" value="${floors}" min="1" max="60"></div>
        <div class="col"><label>每层户数</label><input type="number" id="iUnits" value="${units}" min="1" max="20"></div>
        <div class="col"><label>起始楼层(最底层)</label><input type="number" id="iStart" value="${startFloor}" min="-5" max="10"></div>
        <div class="col"><label>户号方向</label>
          <select id="iOrder"><option value="ltr">从左到右 01→0N</option><option value="rtl">从右到左 0N→01</option></select></div>
        <button id="bSave">保存标定</button>
        <div id="list"></div>
      </div>
    </div>`;

  const cv = root.querySelector<HTMLCanvasElement>('#cv')!;
  const ctx = cv.getContext('2d')!;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;

  function currentCalib(imageDataUrl: string, imgW: number, imgH: number): Calibration {
    return {
      id: editingId || uid(), name: $<HTMLInputElement>('#iName').value || '未命名',
      createdAt: Date.now(), imageDataUrl, imgW, imgH,
      quad: quad.map(p => ({ ...p })) as Quad,
      floors, units, startFloor, unitOrder,
    };
  }

  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (img) {
      const s = Math.min(cv.width / img.width, cv.height / img.height);
      const dw = img.width * s, dh = img.height * s;
      ctx.drawImage(img, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = '#223';
      ctx.font = '15px sans-serif';
      ctx.fillText('请先导入参考图或从视频抓帧', 30, 40);
    }
    const c = currentCalib('', 0, 0);
    const toPx = (p: Pt) => ({ x: p.x * cv.width, y: p.y * cv.height });
    const { rows, cols } = gridLines(c);
    ctx.strokeStyle = 'rgba(77,163,255,.55)';
    ctx.lineWidth = 1;
    for (const [a, b] of rows.concat(cols)) {
      const pa = toPx(a), pb = toPx(b);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
    // 户号标注(隔行显示避免拥挤)
    ctx.fillStyle = 'rgba(77,163,255,.9)';
    ctx.font = '10px sans-serif';
    const labelStep = Math.ceil(c.floors / 12);
    for (let r = 0; r < c.floors; r += labelStep) {
      for (let col = 0; col < c.units; col++) {
        const floor = c.startFloor + (c.floors - 1 - r);
        const unit = c.unitOrder === 'ltr' ? col + 1 : c.units - col;
        const p = toPx(cellCenter(c, r, col));
        ctx.fillText(unitLabel(c, floor, unit), p.x - 8, p.y + 3);
      }
    }
    // 角点
    quad.forEach((p, i) => {
      const px = toPx(p);
      ctx.fillStyle = i === dragIdx ? '#e0a040' : '#4da3ff';
      ctx.beginPath(); ctx.arc(px.x, px.y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '11px sans-serif';
      ctx.fillText(['左上', '右上', '右下', '左下'][i], px.x + 10, px.y + 4);
    });
  }

  function toNorm(e: MouseEvent): Pt {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  cv.addEventListener('mousedown', e => {
    const p = toNorm(e);
    dragIdx = quad.findIndex(q => Math.hypot(q.x - p.x, q.y - p.y) < 0.025);
    draw();
  });
  cv.addEventListener('mousemove', e => {
    if (dragIdx < 0) return;
    const p = toNorm(e);
    quad[dragIdx] = { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
    draw();
  });
  window.addEventListener('mouseup', () => { dragIdx = -1; });

  const bindNum = (sel: string, set: (v: number) => void) =>
    $(sel).addEventListener('input', e => { set(+(e.target as HTMLInputElement).value); draw(); });
  bindNum('#iFloors', v => floors = Math.max(1, v | 0));
  bindNum('#iUnits', v => units = Math.max(1, v | 0));
  bindNum('#iStart', v => startFloor = v | 0);
  $('#iOrder').addEventListener('change', e => { unitOrder = (e.target as HTMLSelectElement).value as 'ltr' | 'rtl'; draw(); });

  function loadImage(dataUrl: string) {
    const im = new Image();
    im.onload = () => { img = im; draw(); };
    im.src = dataUrl;
  }

  $('#fImg').addEventListener('change', e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => loadImage(rd.result as string);
    rd.readAsDataURL(f);
  });

  $('#fVid').addEventListener('change', async e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const v = document.createElement('video');
    v.muted = true; v.src = URL.createObjectURL(f);
    await new Promise(r => { v.onloadeddata = r; });
    v.currentTime = Math.min(1, v.duration * 0.05);
    await new Promise(r => { v.onseeked = r; });
    const c2 = document.createElement('canvas');
    c2.width = v.videoWidth; c2.height = v.videoHeight;
    c2.getContext('2d')!.drawImage(v, 0, 0);
    loadImage(c2.toDataURL('image/jpeg', 0.85));
    URL.revokeObjectURL(v.src);
  });

  $('#fJson').addEventListener('change', e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const c = JSON.parse(rd.result as string) as Calibration;
        if (!c.quad || !c.floors) throw new Error('格式不对');
        c.id = c.id || uid();
        store.saveCalibration(c);
        editingId = c.id;
        quad = c.quad.map(p => ({ ...p })) as Quad;
        floors = c.floors; units = c.units; startFloor = c.startFloor; unitOrder = c.unitOrder;
        $<HTMLInputElement>('#iName').value = c.name;
        $<HTMLInputElement>('#iFloors').value = String(floors);
        $<HTMLInputElement>('#iUnits').value = String(units);
        $<HTMLInputElement>('#iStart').value = String(startFloor);
        if (c.imageDataUrl) loadImage(c.imageDataUrl);
        refreshList(); draw();
      } catch (err) { alert('标定文件解析失败: ' + err); }
    };
    rd.readAsText(f);
  });

  $('#bSave').addEventListener('click', () => {
    if (!img && !editingId) { alert('请先导入参考图'); return; }
    const old = editingId ? store.getCalibration(editingId) : undefined;
    const c = currentCalib(
      img ? img.src : (old?.imageDataUrl || ''),
      img?.naturalWidth || old?.imgW || 0,
      img?.naturalHeight || old?.imgH || 0,
    );
    store.saveCalibration(c);
    editingId = c.id;
    refreshList();
    alert(`已保存标定「${c.name}」`);
  });

  function refreshList() {
    const list = $('#list');
    const all = store.calibrations();
    list.innerHTML = '<h3>已保存标定</h3>' + (all.length ? '' : '<p class="hint">暂无</p>');
    for (const c of all) {
      const div = document.createElement('div');
      div.className = 'row';
      div.style.alignItems = 'center';
      div.innerHTML = `<span style="flex:1">${c.name} <span class="hint">${c.floors}层×${c.units}户</span></span>`;
      const bLoad = document.createElement('button');
      bLoad.className = 'ghost'; bLoad.textContent = '编辑';
      bLoad.onclick = () => {
        editingId = c.id;
        quad = c.quad.map(p => ({ ...p })) as Quad;
        floors = c.floors; units = c.units; startFloor = c.startFloor; unitOrder = c.unitOrder;
        $<HTMLInputElement>('#iName').value = c.name;
        $<HTMLInputElement>('#iFloors').value = String(floors);
        $<HTMLInputElement>('#iUnits').value = String(units);
        $<HTMLInputElement>('#iStart').value = String(startFloor);
        if (c.imageDataUrl) loadImage(c.imageDataUrl);
        draw();
      };
      const bDel = document.createElement('button');
      bDel.className = 'danger'; bDel.textContent = '删除';
      bDel.onclick = () => { store.deleteCalibration(c.id); if (editingId === c.id) editingId = null; refreshList(); };
      div.append(bLoad, bDel);
      list.appendChild(div);
    }
  }

  refreshList();
  draw();
}
