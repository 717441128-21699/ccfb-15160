import type { FacadeCalibration, Vec2 } from '../core/types';
import { createCalibration } from '../core/calibration';
import { calibrationStore } from '../core/storage';
import { drawCalibrationOverlay, fileButton } from './overlay-draw';
import { el, toast, setState, getState, bump } from './app-state';

const CORNER_KEYS: Array<keyof FacadeCalibration['corners']> = ['tl', 'tr', 'bl', 'br'];
const CORNER_NAMES: Record<string, string> = {
  tl: '左上',
  tr: '右上',
  bl: '左下',
  br: '右下',
};

export function renderCalibrationPage(): HTMLElement {
  const existing = calibrationStore.list();
  let cal: FacadeCalibration =
    existing.find((c) => c.id === getState().calibrationId) ??
    existing[0] ??
    createCalibration({ videoWidth: 1280, videoHeight: 720, floors: 18, units: 4 });

  const root = el('div');
  root.append(
    el('h1', { class: 'page-title' }, '楼栋标定'),
    el('p', { class: 'page-desc' }, '导入一段楼面前景画面（或监控截图），拖动四角框出楼面，系统按楼层与户号生成透视网格。一次标定可复用于同一机位的所有视频。'),
  );

  // 左侧：画布
  const stage = el('div', { class: 'video-stage' });
  const baseCanvas = el('canvas', {}) as HTMLCanvasElement;
  const overlay = el('canvas', { class: 'overlay-canvas interactive' }) as HTMLCanvasElement;
  stage.append(baseCanvas, overlay);

  // 右侧：参数面板
  const panel = el('div', { class: 'card' });

  const nameInput = el('input', { value: cal.name }) as HTMLInputElement;
  const floorsInput = el('input', { type: 'number', min: '2', max: '60', value: String(cal.floors) }) as HTMLInputElement;
  const unitsInput = el('input', { type: 'number', min: '1', max: '12', value: String(cal.units) }) as HTMLInputElement;
  const elevInput = el('input', { type: 'number', min: '0', max: '89', value: String(cal.cameraElevationDeg) }) as HTMLInputElement;
  const irCheck = el('input', { type: 'checkbox' }) as HTMLInputElement;
  irCheck.checked = cal.infrared;

  function redraw(): void {
    const ctx = overlay.getContext('2d')!;
    ctx.canvas.width = baseCanvas.width;
    ctx.canvas.height = baseCanvas.height;
    drawCalibrationOverlay(ctx, cal);
    // 四角控制点
    for (const key of CORNER_KEYS) {
      const p = cal.corners[key];
      const x = p.x * overlay.width;
      const y = p.y * overlay.height;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#ffb020';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#1c2430';
      ctx.font = '700 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(CORNER_NAMES[key], x, y);
    }
  }

  function loadPlaceholder(): void {
    baseCanvas.width = 1280;
    baseCanvas.height = 720;
    const ctx = baseCanvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 720);
    grad.addColorStop(0, '#9fc5e8');
    grad.addColorStop(1, '#dce6f2');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#c9c2b4';
    ctx.fillRect(200, 60, 880, 620);
    ctx.fillStyle = '#7d8fa3';
    for (let f = 0; f < 18; f++) {
      for (let u = 0; u < 4; u++) {
        ctx.fillRect(260 + u * 200, 90 + f * 32, 120, 20);
      }
    }
    ctx.fillStyle = 'rgba(28,36,48,0.65)';
    ctx.font = '600 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('未导入画面，当前为示意背景', 640, 40);
    redraw();
  }

  function loadImageFile(file: File): void {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      baseCanvas.width = img.naturalWidth;
      baseCanvas.height = img.naturalHeight;
      baseCanvas.getContext('2d')!.drawImage(img, 0, 0);
      cal.videoWidth = img.naturalWidth;
      cal.videoHeight = img.naturalHeight;
      URL.revokeObjectURL(url);
      redraw();
      toast('画面已载入，拖动四角对齐楼面边缘', 'ok');
    };
    img.src = url;
  }

  function loadVideoFrame(file: File): void {
    const video = document.createElement('video');
    video.src = URL.createObjectURL(file);
    video.muted = true;
    video.onloadeddata = () => {
      video.currentTime = Math.min(0.5, (video.duration || 1) * 0.05);
    };
    video.onseeked = () => {
      baseCanvas.width = video.videoWidth;
      baseCanvas.height = video.videoHeight;
      baseCanvas.getContext('2d')!.drawImage(video, 0, 0);
      cal.videoWidth = video.videoWidth;
      cal.videoHeight = video.videoHeight;
      URL.revokeObjectURL(video.src);
      redraw();
      toast('已抽取视频首帧作为标定底图', 'ok');
    };
  }

  // 四角拖拽
  let dragging: keyof FacadeCalibration['corners'] | null = null;
  overlay.addEventListener('pointerdown', (ev) => {
    const rect = overlay.getBoundingClientRect();
    const nx = (ev.clientX - rect.left) / rect.width;
    const ny = (ev.clientY - rect.top) / rect.height;
    let best: keyof FacadeCalibration['corners'] | null = null;
    let bestD = 0.04;
    for (const key of CORNER_KEYS) {
      const p = cal.corners[key];
      const d = Math.hypot(p.x - nx, p.y - ny);
      if (d < bestD) {
        bestD = d;
        best = key;
      }
    }
    dragging = best;
  });
  overlay.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const rect = overlay.getBoundingClientRect();
    const p: Vec2 = {
      x: Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)),
    };
    cal.corners[dragging] = p;
    cal.updatedAt = Date.now();
    redraw();
  });
  overlay.addEventListener('pointerup', () => (dragging = null));
  overlay.addEventListener('pointerleave', () => (dragging = null));

  function applyGrid(): void {
    const floors = Math.max(2, Math.min(60, parseInt(floorsInput.value, 10) || 18));
    const units = Math.max(1, Math.min(12, parseInt(unitsInput.value, 10) || 4));
    cal.floors = floors;
    cal.units = units;
    cal.floorLabels = Array.from({ length: floors }, (_, i) => `${i + 1}层`);
    cal.unitLabels = Array.from({ length: units }, (_, i) => String(i + 1).padStart(2, '0'));
    redraw();
  }
  floorsInput.addEventListener('change', applyGrid);
  unitsInput.addEventListener('change', applyGrid);
  nameInput.addEventListener('change', () => (cal.name = nameInput.value));
  elevInput.addEventListener('change', () => (cal.cameraElevationDeg = parseInt(elevInput.value, 10) || 0));
  irCheck.addEventListener('change', () => (cal.infrared = irCheck.checked));

  const saveBtn = el('button', { class: 'btn', type: 'button' }, '保存标定');
  saveBtn.addEventListener('click', () => {
    cal.name = nameInput.value || cal.name;
    calibrationStore.save(cal);
    setState({ calibrationId: cal.id });
    bump();
    toast(`标定「${cal.name}」已保存，可用于视频分析`, 'ok');
  });

  const newBtn = el('button', {
    class: 'btn ghost',
    type: 'button',
    onclick: () => {
      cal = createCalibration({
        videoWidth: baseCanvas.width || 1280,
        videoHeight: baseCanvas.height || 720,
        floors: parseInt(floorsInput.value, 10) || 18,
        units: parseInt(unitsInput.value, 10) || 4,
      });
      nameInput.value = cal.name;
      floorsInput.value = String(cal.floors);
      unitsInput.value = String(cal.units);
      loadPlaceholder();
      toast('已创建新标定草稿，记得保存');
    },
  }, '新建标定');

  const savedList = el('div');
  function renderSaved(): void {
    savedList.innerHTML = '';
    const list = calibrationStore.list();
    if (list.length === 0) {
      savedList.append(el('p', { class: 'muted' }, '暂无已保存标定'));
      return;
    }
    for (const item of list) {
      const active = item.id === cal.id;
      const row = el('div', {
        class: `row`,
        style: `padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;cursor:pointer;background:${active ? '#eef4ff' : '#fff'}`,
        onclick: () => {
          cal = structuredClone(item);
          nameInput.value = cal.name;
          floorsInput.value = String(cal.floors);
          unitsInput.value = String(cal.units);
          elevInput.value = String(cal.cameraElevationDeg);
          irCheck.checked = cal.infrared;
          if (baseCanvas.width === 0) loadPlaceholder();
          else redraw();
        },
      },
        el('div', { style: 'flex:1;font-weight:600' }, item.name),
        el('span', { class: 'tag info' }, `${item.floors}层×${item.units}户`),
        el('button', {
          class: 'btn danger',
          style: 'padding:4px 10px;font-size:12px',
          onclick: (ev: Event) => {
            ev.stopPropagation();
            if (confirm(`删除标定「${item.name}」？`)) {
              calibrationStore.remove(item.id);
              renderSaved();
            }
          },
        }, '删除'),
      );
      savedList.append(row);
    }
  }

  panel.append(
    el('h3', {}, '标定参数'),
    el('label', { class: 'field' }, el('b', {}, '楼栋/机位名称'), nameInput),
    el('div', { class: 'grid-2', style: 'margin-top:10px' },
      el('label', { class: 'field' }, el('b', {}, '楼层数'), floorsInput),
      el('label', { class: 'field' }, el('b', {}, '每层户数'), unitsInput),
    ),
    el('div', { class: 'grid-2', style: 'margin-top:10px' },
      el('label', { class: 'field' }, el('b', {}, '摄像头仰角(°)'), elevInput),
      el('label', { class: 'field' }, el('b', {}, '夜间红外机位'), irCheck),
    ),
    el('div', { class: 'row', style: 'margin-top:14px' }, saveBtn, newBtn),
    el('h3', { style: 'margin-top:18px' }, '导入标定底图'),
    el('div', { class: 'row' },
      fileButton('导入截图', 'image/*', loadImageFile, 'secondary'),
      fileButton('导入视频抽帧', 'video/*', loadVideoFrame, 'secondary'),
    ),
    el('h3', { style: 'margin-top:18px' }, '已保存标定'),
    savedList,
  );

  const wrap = el('div', { class: 'grid-2', style: 'grid-template-columns: 1.7fr 1fr;align-items:start' }, stage, panel);
  root.append(wrap);
  loadPlaceholder();
  renderSaved();
  return root;
}
