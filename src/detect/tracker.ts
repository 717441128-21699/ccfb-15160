// 多目标跟踪: 最近邻 + 匀速预测, 输出完整轨迹
import type { Blob } from './blobs';
import type { TrackPoint } from '../types';

export interface TrackerParams {
  maxDist: number;     // 关联距离(归一化), 默认 0.08
  maxMisses: number;   // 允许丢失帧数, 默认 5
  minHits: number;     // 确认轨迹的最小命中数, 默认 4
  maxPoints: number;   // 单条轨迹最大点数
}

export const DEFAULT_TRACKER: TrackerParams = { maxDist: 0.08, maxMisses: 5, minHits: 4, maxPoints: 240 };

interface LiveTrack {
  id: number;
  points: TrackPoint[];
  misses: number;
  vx: number; vy: number; // 归一化/秒
  done: boolean;
}

export class Tracker {
  private tracks: LiveTrack[] = [];
  private nextId = 1;
  constructor(private p: TrackerParams = DEFAULT_TRACKER) {}

  /** 输入一帧的 blobs(像素坐标 + 帧尺寸), 返回本帧确认完成的轨迹 */
  update(blobs: Blob[], t: number, w: number, h: number): LiveTrack[] {
    const pts = blobs.map(b => ({
      t, x: b.x / w, y: b.y / h,
      w: (b.maxX - b.minX + 1) / w, h: (b.maxY - b.minY + 1) / h,
      area: b.area,
    }));
    const active = this.tracks.filter(tr => !tr.done);
    const usedTrack = new Set<number>();
    const usedPt = new Set<number>();
    // 贪心关联: 按距离升序
    const pairs: { d: number; ti: number; pi: number }[] = [];
    for (let ti = 0; ti < active.length; ti++) {
      const tr = active[ti];
      const last = tr.points[tr.points.length - 1];
      const dt = Math.max(1e-3, t - last.t);
      const px = last.x + tr.vx * dt, py = last.y + tr.vy * dt;
      for (let pi = 0; pi < pts.length; pi++) {
        const d = Math.hypot(pts[pi].x - px, pts[pi].y - py);
        if (d < this.p.maxDist) pairs.push({ d, ti, pi });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    for (const { ti, pi } of pairs) {
      if (usedTrack.has(ti) || usedPt.has(pi)) continue;
      usedTrack.add(ti); usedPt.add(pi);
      const tr = active[ti];
      const last = tr.points[tr.points.length - 1];
      const dt = Math.max(1e-3, t - last.t);
      const nvx = (pts[pi].x - last.x) / dt, nvy = (pts[pi].y - last.y) / dt;
      tr.vx = 0.6 * tr.vx + 0.4 * nvx;
      tr.vy = 0.6 * tr.vy + 0.4 * nvy;
      tr.points.push(pts[pi]);
      if (tr.points.length > this.p.maxPoints) tr.points.shift();
      tr.misses = 0;
    }
    for (let ti = 0; ti < active.length; ti++) if (!usedTrack.has(ti)) active[ti].misses++;
    for (let pi = 0; pi < pts.length; pi++) {
      if (usedPt.has(pi)) continue;
      this.tracks.push({ id: this.nextId++, points: [pts[pi]], misses: 0, vx: 0, vy: 0, done: false });
    }
    // 终结丢失过久的轨迹
    const finished: LiveTrack[] = [];
    for (const tr of this.tracks) {
      if (!tr.done && tr.misses > this.p.maxMisses) {
        tr.done = true;
        if (tr.points.length >= this.p.minHits) finished.push(tr);
      }
    }
    return finished;
  }

  /** 视频结束时冲刷所有未完成的轨迹 */
  flush(): LiveTrack[] {
    const out: LiveTrack[] = [];
    for (const tr of this.tracks) {
      if (!tr.done) {
        tr.done = true;
        if (tr.points.length >= this.p.minHits) out.push(tr);
      }
    }
    return out;
  }
}

export type { LiveTrack };
