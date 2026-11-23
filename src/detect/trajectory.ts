// 轨迹拟合与抛出点回推
import type { Calibration, Pt, TrackPoint } from '../types';
import { insideQuad } from '../calib/geometry';

export interface TrajectoryFit {
  // x(t) = ax0 + ax1 * t + ax2 * t^2  (二次项吸收风力渐强的漂移)
  ax0: number; ax1: number; ax2: number;
  // y(t) = ay0 + ay1 * t + ay2 * t^2  (重力加速度项)
  ay0: number; ay1: number; ay2: number;
  t0: number;          // 轨迹首点时间
  rms: number;         // 拟合残差(归一化坐标)
  n: number;
}

/** 解 3x3 线性方程组 (高斯消元, 原地) */
function solve3(m: number[][]): [number, number, number] | null {
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** 最小二乘拟合: x/y 均为二次。
 *  只用轨迹前 windowSec 秒: 抛出初段受终端速度/阵风影响最小, 且离抛出点最近,
 *  用长轨迹反而会被终端速度的"弯折"带偏截距。 */
export function fitTrajectory(points: TrackPoint[], windowSec = 1.2): TrajectoryFit | null {
  const t0all = points[0].t;
  let pts = points.filter(p => p.t - t0all <= windowSec);
  if (pts.length < 4) pts = points;
  const n = pts.length;
  if (n < 4) return null;
  const t0 = pts[0].t;
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let sy0 = 0, sy1 = 0, sy2 = 0;
  let sx0 = 0, sx1 = 0, sx2 = 0;
  for (const p of pts) {
    const t = p.t - t0;
    const t2 = t * t, t3 = t2 * t, t4 = t3 * t;
    s1 += t; s2 += t2; s3 += t3; s4 += t4;
    sy0 += p.y; sy1 += t * p.y; sy2 += t2 * p.y;
    sx0 += p.x; sx1 += t * p.x; sx2 += t2 * p.x;
  }
  const A = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]];
  const ySol = solve3(A.map((r, i) => [...r, [sy0, sy1, sy2][i]]));
  const xSol = solve3(A.map((r, i) => [...r, [sx0, sx1, sx2][i]]));
  if (!ySol || !xSol) return null;
  const [ay0, ay1, ay2] = ySol;
  const [ax0, ax1, ax2] = xSol;
  // 残差
  let se = 0;
  for (const p of pts) {
    const t = p.t - t0;
    const ex = p.x - (ax0 + ax1 * t + ax2 * t * t);
    const ey = p.y - (ay0 + ay1 * t + ay2 * t * t);
    se += ex * ex + ey * ey;
  }
  return { ax0, ax1, ax2, ay0, ay1, ay2, t0, rms: Math.sqrt(se / n), n };
}

export function evalFit(f: TrajectoryFit, t: number): Pt {
  const dt = t - f.t0;
  return { x: f.ax0 + f.ax1 * dt + f.ax2 * dt * dt, y: f.ay0 + f.ay1 * dt + f.ay2 * dt * dt };
}

export interface BackProjectResult {
  throwPoint: Pt;
  throwTime: number;   // 回推的抛出时刻(视频时间)
  backDistance: number; // 回推时长(秒), 越大越不可靠
}

/**
 * 沿拟合抛物线向过去回溯, 找到轨迹进入标定楼面的点。
 * 轨迹首点已在楼面内时直接取首点。
 */
export function backProject(fit: TrajectoryFit, calib: Calibration, maxBackSec = 4): BackProjectResult | null {
  const first = evalFit(fit, fit.t0);
  if (insideQuad(calib.quad, first)) {
    return { throwPoint: first, throwTime: fit.t0, backDistance: 0 };
  }
  const step = 1 / 120;
  for (let back = step; back <= maxBackSec; back += step) {
    const t = fit.t0 - back;
    const p = evalFit(fit, t);
    if (insideQuad(calib.quad, p)) {
      return { throwPoint: p, throwTime: t, backDistance: back };
    }
    // 已经飞到图像外很远, 放弃
    if (p.y < -0.5 || p.x < -0.5 || p.x > 1.5) break;
  }
  return null;
}

/** 置信度: 拟合残差小、轨迹长、回推距离短 => 高 */
export function confidence(fit: TrajectoryFit, back: BackProjectResult): number {
  const rmsScore = Math.max(0, 1 - fit.rms / 0.02);          // 残差 0.02 以上记 0
  const lenScore = Math.min(1, fit.n / 12);                   // 12 个采样点以上满分
  const backScore = Math.max(0, 1 - back.backDistance / 2);   // 回推 2s 以上记 0
  return Math.round((0.45 * rmsScore + 0.25 * lenScore + 0.3 * backScore) * 100) / 100;
}
