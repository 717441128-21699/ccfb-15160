import { describe, it, expect } from 'vitest';
import { mergeEvents } from '../src/core/event-merge';
import type { ThrowEvent } from '../src/core/types';

function makeEvent(
  id: string,
  startSec: number,
  endSec: number,
  floorIndex: number,
  unitIndex: number,
  point: { x: number; y: number },
  confidence: number,
): ThrowEvent {
  return {
    id,
    calibrationId: 'cal1',
    videoName: 'v.mp4',
    startSec,
    endSec,
    startFrame: 0,
    endFrame: 0,
    track: {
      id: Number(id.replace('e', '')), points: [], lastDetectionId: 0, missed: 0,
      kind: 'object', score: confidence, features: {
        durationSec: 0.5, pointCount: 10, verticalDrop: 100, horizontalDrift: 0,
        straightness: 0.9, accelY: 300, fitRms: 2, downwardRatio: 1, meanArea: 20,
        areaCv: 0.2, meanAspect: 1, meanVy: 200,
      }, closed: true, finalized: true,
    },
    origin: {
      point,
      cell: { floorIndex, unitIndex, floorLabel: `${floorIndex + 1}层`, unitLabel: `0${unitIndex + 1}` },
      floorProbabilities: [], unitProbabilities: [], floorSigma: 0.5, unitSigma: 0.5,
      confidence, launchTimeSec: startSec, launchVelocity: { x: 0, y: 0 },
      gravityPx: 500, fitRmsPx: 2, reasons: [],
    },
    infrared: false,
    thumbnails: [],
    createdAt: 0,
  };
}

describe('mergeEvents', () => {
  it('合并同户号、时间相邻、位置接近的碎片事件', () => {
    const events = [
      makeEvent('e1', 3.0, 3.8, 14, 2, { x: 0.5, y: 0.3 }, 0.7),
      makeEvent('e2', 4.0, 4.9, 14, 2, { x: 0.51, y: 0.31 }, 0.85),
      makeEvent('e3', 5.0, 5.8, 15, 2, { x: 0.52, y: 0.32 }, 0.6),
    ];
    const out = mergeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0].origin.confidence).toBe(0.85); // 保留最高置信
    expect(out[0].startSec).toBe(3.0);
    expect(out[0].endSec).toBe(5.8);
  });

  it('不合并不同户号或时间间隔过大的事件', () => {
    const events = [
      makeEvent('e1', 3.0, 3.8, 14, 2, { x: 0.5, y: 0.3 }, 0.7),
      makeEvent('e2', 8.0, 8.8, 14, 2, { x: 0.5, y: 0.3 }, 0.8), // 间隔 >1.5s
      makeEvent('e3', 9.0, 9.8, 14, 0, { x: 0.2, y: 0.3 }, 0.8), // 不同户号
    ];
    const out = mergeEvents(events);
    expect(out).toHaveLength(3);
  });

  it('空数组安全返回', () => {
    expect(mergeEvents([])).toEqual([]);
  });
});
