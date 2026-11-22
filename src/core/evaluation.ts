import type { ThrowEvent } from './types';
import type { GroundTruthEvent } from './synthetic';

export interface EvaluationRow {
  truth: GroundTruthEvent;
  matched?: ThrowEvent;
  /** 楼层偏差绝对值（层） */
  floorError?: number;
  unitCorrect?: boolean;
  matchedBy: 'time' | 'unmatched';
}

export interface EvaluationReport {
  truthCount: number;
  detectedCount: number;
  matchedCount: number;
  /** 召回率 = 匹配上的真值 / 全部真值 */
  recall: number;
  /** 精确率 = 匹配上的检测 / 全部检测 */
  precision: number;
  /** 户号判对率（仅统计匹配成功的样本） */
  unitAccuracy: number;
  /** 楼层平均绝对误差（层） */
  meanFloorError: number;
  /** 楼层误差 ≤ 1 层的比例 */
  floorWithinOneRate: number;
  rows: EvaluationRow[];
  falsePositives: ThrowEvent[];
  passFloor: boolean;
  passUnit: boolean;
}

/**
 * 按时间最近邻做一对一匹配（事件量级小，贪心即可）。
 * 距离 = 真值时刻到事件时间区间的距离：真值落在区间内为 0，否则取到近端的间隔。
 * toleranceSec 以外不匹配。用区间而非单点，吸收轨迹闭合延迟对 startSec 的影响。
 */
export function evaluate(
  events: ThrowEvent[],
  truth: GroundTruthEvent[],
  toleranceSec = 4,
): EvaluationReport {
  const timeDistance = (e: ThrowEvent, t: GroundTruthEvent): number => {
    if (t.startSec < e.startSec) return e.startSec - t.startSec;
    if (t.startSec > e.endSec) return t.startSec - e.endSec;
    return 0;
  };
  const pairs: { ti: number; ei: number; dt: number }[] = [];
  truth.forEach((t, ti) => {
    events.forEach((e, ei) => {
      const dt = timeDistance(e, t);
      if (dt <= toleranceSec) pairs.push({ ti, ei, dt });
    });
  });
  pairs.sort((a, b) => a.dt - b.dt);
  const usedTruth = new Set<number>();
  const usedEvents = new Set<number>();
  const matchMap = new Map<number, number>(); // truth index → event index
  for (const p of pairs) {
    if (usedTruth.has(p.ti) || usedEvents.has(p.ei)) continue;
    usedTruth.add(p.ti);
    usedEvents.add(p.ei);
    matchMap.set(p.ti, p.ei);
  }

  const rows: EvaluationRow[] = [];
  let floorErrors: number[] = [];
  let unitCorrectCount = 0;
  for (let ti = 0; ti < truth.length; ti++) {
    const t = truth[ti];
    const ei = matchMap.get(ti);
    if (ei === undefined) {
      rows.push({ truth: t, matchedBy: 'unmatched' });
      continue;
    }
    const e = events[ei];
    const floorError = Math.abs(e.origin.cell.floorIndex - t.floorIndex);
    const unitCorrect = e.origin.cell.unitIndex === t.unitIndex;
    floorErrors.push(floorError);
    if (unitCorrect) unitCorrectCount++;
    rows.push({
      truth: t,
      matched: e,
      floorError,
      unitCorrect,
      matchedBy: 'time',
    });
  }

  const falsePositives = events.filter((_, ei) => !usedEvents.has(ei));
  const matchedCount = matchMap.size;
  const meanFloorError = floorErrors.length
    ? floorErrors.reduce((a, b) => a + b, 0) / floorErrors.length
    : NaN;
  const floorWithinOneRate = floorErrors.length
    ? floorErrors.filter((x) => x <= 1).length / floorErrors.length
    : 0;
  const unitAccuracy = matchedCount ? unitCorrectCount / matchedCount : 0;

  return {
    truthCount: truth.length,
    detectedCount: events.length,
    matchedCount,
    recall: truth.length ? matchedCount / truth.length : 0,
    precision: events.length ? matchedCount / events.length : 0,
    unitAccuracy,
    meanFloorError,
    floorWithinOneRate,
    rows,
    falsePositives,
    passFloor: floorWithinOneRate >= 1, // 误差不超过一层 = 100% 样本 ≤1
    passUnit: unitAccuracy >= 0.9,
  };
}

export function formatSec(v: number): string {
  const m = Math.floor(v / 60);
  const s = (v % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}
