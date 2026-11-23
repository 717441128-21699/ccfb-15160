// 轨迹特征提取与目标分类: 下落物 / 树叶 / 鸟 / 雨滴 / 噪声
import type { TrackClass, TrackPoint } from '../types';

export interface TrackFeatures {
  n: number;
  duration: number;      // 秒
  netDx: number; netDy: number;   // 归一化位移
  pathLen: number;
  straightness: number;  // 位移/路径
  meanVy: number;        // 归一化/秒, 向下为正
  vyGain: number;        // 末段 vy - 首段 vy (加速下落特征)
  vxSignChanges: number; // 水平方向抖动(树叶特征)
  sizeMean: number;      // 平均面积(处理分辨率像素)
  sizeVar: number;       // 面积变异系数(鸟扇翅特征)
  verticality: number;   // |dy| / (|dx|+|dy|)
}

export function extractFeatures(points: TrackPoint[]): TrackFeatures {
  const n = points.length;
  const first = points[0], last = points[n - 1];
  const duration = Math.max(1e-3, last.t - first.t);
  const netDx = last.x - first.x, netDy = last.y - first.y;
  let pathLen = 0, vxSignChanges = 0, prevVx = 0;
  let sumArea = 0, sumArea2 = 0;
  const vys: number[] = [];
  for (let i = 1; i < n; i++) {
    const a = points[i - 1], b = points[i];
    const dt = Math.max(1e-3, b.t - a.t);
    const dx = b.x - a.x, dy = b.y - a.y;
    pathLen += Math.hypot(dx, dy);
    const vx = dx / dt;
    if (i > 1 && Math.sign(vx) !== 0 && Math.sign(prevVx) !== 0 && Math.sign(vx) !== Math.sign(prevVx)) vxSignChanges++;
    if (Math.abs(vx) > 0.01) prevVx = vx;
    vys.push(dy / dt);
  }
  for (const p of points) { sumArea += p.area; sumArea2 += p.area * p.area; }
  const sizeMean = sumArea / n;
  const sizeVar = sizeMean > 0 ? Math.sqrt(Math.max(0, sumArea2 / n - sizeMean * sizeMean)) / sizeMean : 0;
  const third = Math.max(1, Math.floor(vys.length / 3));
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
  const vyHead = mean(vys.slice(0, third));
  const vyTail = mean(vys.slice(-third));
  const net = Math.hypot(netDx, netDy);
  return {
    n, duration, netDx, netDy, pathLen,
    straightness: pathLen > 1e-6 ? net / pathLen : 0,
    meanVy: netDy / duration,
    vyGain: vyTail - vyHead,
    vxSignChanges,
    sizeMean, sizeVar,
    verticality: (Math.abs(netDx) + Math.abs(netDy)) > 1e-6 ? Math.abs(netDy) / (Math.abs(netDx) + Math.abs(netDy)) : 0,
  };
}

export interface ClassifyParams {
  minDrop: number;       // 最小下落位移(归一化), 默认 0.04
  minFallSpeed: number;  // 最小下落速度(归一化/秒), 默认 0.08
  rainSpeed: number;     // 雨滴速度阈值, 默认 0.9
  minArea: number;
}

export const DEFAULT_CLASSIFY: ClassifyParams = {
  minDrop: 0.04, minFallSpeed: 0.08, rainSpeed: 0.9, minArea: 6,
};

export function classifyTrack(f: TrackFeatures, p: ClassifyParams = DEFAULT_CLASSIFY): TrackClass {
  if (f.n < 3 || f.sizeMean < p.minArea) return 'noise';
  // 雨: 极快、近竖直、目标小、持续短
  if (f.meanVy > p.rainSpeed && f.verticality > 0.9 && f.sizeMean < 60 && f.duration < 0.5) return 'rain';
  // 鸟: 水平为主, 或面积剧烈变化(扇翅), 且无持续下落
  if (Math.abs(f.netDx) > 2.5 * Math.abs(f.netDy) && f.netDy < p.minDrop) return 'bird';
  if (f.sizeVar > 0.55 && f.meanVy < p.minFallSpeed) return 'bird';
  // 树叶: 慢、飘(水平方向反复变向、路径弯曲)
  if (f.vxSignChanges >= 3 && f.meanVy < p.minFallSpeed * 1.5) return 'leaf';
  if (f.straightness < 0.45 && f.meanVy < p.minFallSpeed) return 'leaf';
  // 下落物: 明显净下落、速度足够、轨迹较直
  if (f.netDy > p.minDrop && f.meanVy > p.minFallSpeed && f.straightness > 0.55 && f.verticality > 0.5) return 'fall';
  return 'unknown';
}

/** 根据轨迹特征猜测物体类型(仅用于报告展示) */
export function guessObject(f: TrackFeatures): string {
  if (f.sizeMean > 400) return '大件物品(纸箱/垃圾袋)';
  if (f.vxSignChanges >= 2) return '轻质飘动物(纸张/塑料袋)';
  if (f.meanVy > 0.9) return '重物(瓶罐类)';
  if (f.sizeMean < 40) return '小物件(烟头/果核)';
  return '一般抛掷物';
}
