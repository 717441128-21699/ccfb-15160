import type { ThrowEvent } from './types';

/**
 * 合并由同一条物理轨迹碎裂产生的多个事件。
 * 归并条件（同时满足）：
 *  1. 同一标定、同一户号（楼层允许相邻 1 层，吸收楼层抖动）；
 *  2. 时间间隔 ≤ gapSec（碎片间漏检窗口通常 <1.5s）；
 *  3. 抛出点图像距离 ≤ maxDist（归一化）。
 * 合并后保留置信度最高的事件，时间区间取并集。
 */
export function mergeEvents(
  events: ThrowEvent[],
  opts: { gapSec?: number; maxDist?: number } = {},
): ThrowEvent[] {
  const gapSec = opts.gapSec ?? 1.5;
  const maxDist = opts.maxDist ?? 0.18;
  const sorted = [...events].sort((a, b) => a.startSec - b.startSec);
  const used = new Array(sorted.length).fill(false);
  const out: ThrowEvent[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const cluster: ThrowEvent[] = [sorted[i]];
    let anchor = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      const cand = sorted[j];
      const sameUnit =
        cand.origin.cell.unitIndex === anchor.origin.cell.unitIndex &&
        Math.abs(cand.origin.cell.floorIndex - anchor.origin.cell.floorIndex) <= 1;
      const timeClose = cand.startSec - anchor.endSec <= gapSec;
      const d = Math.hypot(
        cand.origin.point.x - anchor.origin.point.x,
        cand.origin.point.y - anchor.origin.point.y,
      );
      if (sameUnit && timeClose && d <= maxDist) {
        cluster.push(cand);
        used[j] = true;
        anchor = cand; // 链式聚合
      }
    }
    // 选置信度最高者为代表，扩展时间区间
    const best = cluster.reduce((a, b) => (b.origin.confidence > a.origin.confidence ? b : a));
    if (cluster.length === 1) {
      out.push(best);
    } else {
      out.push({
        ...best,
        startSec: Math.min(...cluster.map((e) => e.startSec)),
        endSec: Math.max(...cluster.map((e) => e.endSec)),
        thumbnails: best.thumbnails,
      });
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}
