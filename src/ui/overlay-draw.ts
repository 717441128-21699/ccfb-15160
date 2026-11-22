import type { FacadeCalibration, Vec2 } from '../core/types';
import { gridLines, facadeOutline, gridToImage } from '../core/calibration';
import { el } from './app-state';

/** 在画布上绘制楼面网格叠加层（画布尺寸 = 显示尺寸，坐标为归一化） */
export function drawCalibrationOverlay(
  ctx: CanvasRenderingContext2D,
  cal: FacadeCalibration,
  opts: { highlightCell?: { floorIndex: number; unitIndex: number } | null; labels?: boolean } = {},
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  const lines = gridLines(cal);

  // 楼面半透明填充
  const outline = facadeOutline(cal);
  ctx.beginPath();
  outline.forEach((p, i) => {
    const x = p.x * W;
    const y = p.y * H;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(29, 99, 216, 0.10)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(29, 99, 216, 0.95)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(96, 165, 250, 0.75)';
  ctx.lineWidth = 1;
  for (const line of [...lines.horizontal, ...lines.vertical]) {
    ctx.beginPath();
    line.forEach((p, i) => {
      const x = p.x * W;
      const y = p.y * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // 高亮单元
  if (opts.highlightCell) {
    const { floorIndex, unitIndex } = opts.highlightCell;
    const [tl, tr, br, bl] = [
      gridPoint(cal, unitIndex, floorIndex + 1),
      gridPoint(cal, unitIndex + 1, floorIndex + 1),
      gridPoint(cal, unitIndex + 1, floorIndex),
      gridPoint(cal, unitIndex, floorIndex),
    ];
    ctx.beginPath();
    [tl, tr, br, bl].forEach((p, i) => {
      const x = p.x * W;
      const y = p.y * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(216, 58, 58, 0.32)';
    ctx.fill();
    ctx.strokeStyle = '#d83a3a';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  if (opts.labels !== false) {
    // 楼层标签（左侧）与户号标签（顶部）
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '600 12px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let f = 0; f < cal.floors; f++) {
      const p = gridPoint(cal, 0, f + 0.5);
      ctx.fillText(cal.floorLabels[f], p.x * W - 6, p.y * H);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let u = 0; u < cal.units; u++) {
      const p = gridPoint(cal, u + 0.5, cal.floors);
      ctx.fillText(cal.unitLabels[u], p.x * W, p.y * H - 4);
    }
  }
}

function gridPoint(cal: FacadeCalibration, u: number, v: number): Vec2 {
  return gridToImage(cal, { u, v });
}

/** 绘制轨迹与抛出点（分析页/事件详情用） */
export function drawTrackOverlay(
  ctx: CanvasRenderingContext2D,
  cal: FacadeCalibration | null,
  trackPoints: Array<{ x: number; y: number }>,
  originPoint?: Vec2 | null,
  analysisSize?: { width: number; height: number },
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (cal) drawCalibrationOverlay(ctx, cal, { labels: false });

  if (trackPoints.length > 1) {
    ctx.beginPath();
    trackPoints.forEach((p, i) => {
      const sx = analysisSize ? (p.x / analysisSize.width) * W : p.x * W;
      const sy = analysisSize ? (p.y / analysisSize.height) * H : p.y * H;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.strokeStyle = '#ffb020';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    ctx.stroke();

    // 点标记
    ctx.fillStyle = '#ffb020';
    for (const p of trackPoints) {
      const sx = analysisSize ? (p.x / analysisSize.width) * W : p.x * W;
      const sy = analysisSize ? (p.y / analysisSize.height) * H : p.y * H;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (originPoint) {
    const x = originPoint.x * W;
    const y = originPoint.y * H;
    ctx.strokeStyle = '#d83a3a';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 17, y);
    ctx.lineTo(x + 17, y);
    ctx.moveTo(x, y - 17);
    ctx.lineTo(x, y + 17);
    ctx.stroke();
  }
}

/** 通用文件选择按钮封装 */
export function fileButton(
  label: string,
  accept: string,
  onFile: (f: File) => void,
  kind: 'btn' | 'secondary' = 'btn',
): HTMLButtonElement {
  const input = el('input', {
    type: 'file',
    accept,
    style: 'display:none',
    onchange: () => {
      const f = input.files?.[0];
      if (f) onFile(f);
      input.value = '';
    },
  }) as HTMLInputElement;
  const btn = el('button', { class: `btn ${kind === 'btn' ? '' : 'secondary'}`, type: 'button' }, label);
  btn.addEventListener('click', () => input.click());
  btn.append(input);
  return btn;
}
