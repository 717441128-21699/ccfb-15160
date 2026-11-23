// 标定网格几何: 四边形双线性映射, 点 -> (楼层, 户号)
import type { Calibration, Pt, Quad } from '../types';

/** 双线性插值: u 列向(0左..1右), v 行向(0上..1下) */
export function bilinear(quad: Quad, u: number, v: number): Pt {
  const [tl, tr, br, bl] = quad;
  const x = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x;
  const y = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y;
  return { x, y };
}

/** 双线性逆映射(牛顿迭代), 返回 [u, v]; 不保证在 [0,1] 内 */
export function invBilinear(quad: Quad, p: Pt): [number, number] {
  const [tl, tr, br, bl] = quad;
  // 初值: 四边形中心为 (0.5, 0.5)
  let u = 0.5, v = 0.5;
  const ax = tl.x, ay = tl.y;
  const bx = tr.x - tl.x, by = tr.y - tl.y;
  const cx = bl.x - tl.x, cy = bl.y - tl.y;
  const dx = tl.x - tr.x + br.x - bl.x, dy = tl.y - tr.y + br.y - bl.y;
  for (let i = 0; i < 24; i++) {
    const fx = ax + bx * u + cx * v + dx * u * v - p.x;
    const fy = ay + by * u + cy * v + dy * u * v - p.y;
    if (fx * fx + fy * fy < 1e-16) break;
    const j00 = bx + dx * v, j01 = cx + dx * u;
    const j10 = by + dy * v, j11 = cy + dy * u;
    const det = j00 * j11 - j01 * j10;
    if (Math.abs(det) < 1e-12) break;
    u -= (j11 * fx - j01 * fy) / det;
    v -= (-j10 * fx + j00 * fy) / det;
  }
  return [u, v];
}

export function insideQuad(quad: Quad, p: Pt): boolean {
  const [u, v] = invBilinear(quad, p);
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

export interface CellHit { floor: number; unit: number; row: number; col: number }

/** 点 -> 楼层/户号; 点不在网格内返回 null */
export function cellAt(calib: Calibration, p: Pt): CellHit | null {
  const [u, v] = invBilinear(calib.quad, p);
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const row = Math.min(calib.floors - 1, Math.max(0, Math.floor(v * calib.floors)));
  const col = Math.min(calib.units - 1, Math.max(0, Math.floor(u * calib.units)));
  const floor = calib.startFloor + (calib.floors - 1 - row);
  const unit = calib.unitOrder === 'ltr' ? col + 1 : calib.units - col;
  return { floor, unit, row, col };
}

/** 网格线(用于绘制): 返回楼层分隔线( floors+1 条)与户分隔线( units+1 条) */
export function gridLines(calib: Calibration): { rows: [Pt, Pt][]; cols: [Pt, Pt][] } {
  const rows: [Pt, Pt][] = [];
  const cols: [Pt, Pt][] = [];
  for (let r = 0; r <= calib.floors; r++) {
    const v = r / calib.floors;
    rows.push([bilinear(calib.quad, 0, v), bilinear(calib.quad, 1, v)]);
  }
  for (let c = 0; c <= calib.units; c++) {
    const u = c / calib.units;
    cols.push([bilinear(calib.quad, u, 0), bilinear(calib.quad, u, 1)]);
  }
  return { rows, cols };
}

/** 单元格中心 */
export function cellCenter(calib: Calibration, row: number, col: number): Pt {
  return bilinear(calib.quad, (col + 0.5) / calib.units, (row + 0.5) / calib.floors);
}
