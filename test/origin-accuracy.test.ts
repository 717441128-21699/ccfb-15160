import { describe, it, expect } from 'vitest';
import { estimateOrigin } from '../src/core/origin';
import { createCalibration, gridToImage } from '../src/core/calibration';
import { extractFeatures } from '../src/core/tracker';
import type { Track, TrackPoint, FacadeCalibration } from '../src/core/types';

const G = 5.2; // 与合成器 GRAVITY_GRID 一致

function makeCal(): FacadeCalibration {
  const cal = createCalibration({ videoWidth: 960, videoHeight: 540, floors: 18, units: 4 });
  cal.corners = {
    tl: { x: 0.1, y: 0.05 },
    tr: { x: 0.9, y: 0.05 },
    bl: { x: 0.1, y: 0.95 },
    br: { x: 0.9, y: 0.95 },
  };
  return cal;
}

/**
 * 用合成器同款物理公式生成一条从 (floor,unit) 抛出的轨迹，
 * 模拟"抛出后 0.2s 才被观测到、观测 1s"的真实情形。
 * noisePx：注入的质心高斯噪声标准差（像素），模拟帧差 blob 抖动。
 */
function synthTrack(
  cal: FacadeCalibration,
  floor: number,
  unit: number,
  vx: number,
  vy: number,
  obsStart = 0.2,
  obsEnd = 1.2,
  noisePx = 0,
): Track {
  const W = 960;
  const H = 540;
  const pts: TrackPoint[] = [];
  const dt = 0.08;
  let idx = 0;
  // 确定性伪随机（线性同余），保证测试可复现
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let t = obsStart; t <= obsEnd; t += dt) {
    const u = unit + 0.5 + vx * t;
    const v = floor + 0.55 + vy * t - 0.5 * G * t * t;
    const img = gridToImage(cal, { u, v });
    pts.push({
      frame: idx,
      timeSec: idx * dt,
      x: img.x * W + rand() * 2 * noisePx,
      y: img.y * H + rand() * 2 * noisePx,
    });
    idx++;
  }
  return {
    id: 1, points: pts, lastDetectionId: 0, missed: 0, kind: 'object', score: 0.9,
    features: extractFeatures(pts), closed: true, finalized: true,
  };
}

describe('反推专项（合成器物理轨迹）', () => {
  const cal = makeCal();
  const cases = [
    { floor: 16, unit: 2, vx: 0.1, vy: 0.2 },
    { floor: 12, unit: 1, vx: -0.2, vy: 0.0 },
    { floor: 8, unit: 3, vx: 0.3, vy: 0.5 },
    { floor: 14, unit: 0, vx: 0.0, vy: -0.2 },
  ];
  for (const c of cases) {
    it(`真值 ${c.floor}层/${c.unit}户 vx=${c.vx}`, () => {
      const track = synthTrack(cal, c.floor, c.unit, c.vx, c.vy);
      const origin = estimateOrigin(track, cal, {
        analysisWidth: 960,
        analysisHeight: 540,
        windCompensation: 0.2,
      });
      const floorErr = Math.abs(origin.cell.floorIndex - c.floor);
      const unitErr = Math.abs(origin.cell.unitIndex - c.unit);
      // 打印供调参观察
      console.log(
        `真值 ${c.floor}层/${c.unit}户 → 估计 ${origin.cell.floorLabel}/${origin.cell.unitLabel}户 ` +
          `楼层误差=${floorErr} 户号误差=${unitErr} 出手t=${origin.launchTimeSec.toFixed(2)}`,
      );
      expect(floorErr).toBeLessThanOrEqual(2);
      expect(unitErr).toBeLessThanOrEqual(1);
    });
  }

  it('在 ±8px 质心噪声下楼层误差仍 ≤1 层', () => {
    let maxFloorErr = 0;
    let maxUnitErr = 0;
    for (const c of cases) {
      const track = synthTrack(cal, c.floor, c.unit, c.vx, c.vy, 0.2, 1.2, 8);
      const origin = estimateOrigin(track, cal, {
        analysisWidth: 960, analysisHeight: 540, windCompensation: 0.2,
      });
      maxFloorErr = Math.max(maxFloorErr, Math.abs(origin.cell.floorIndex - c.floor));
      maxUnitErr = Math.max(maxUnitErr, Math.abs(origin.cell.unitIndex - c.unit));
    }
    console.log(`±8px 噪声：最大楼层误差=${maxFloorErr} 最大户号误差=${maxUnitErr}`);
    expect(maxFloorErr).toBeLessThanOrEqual(1);
  });
});
