import { describe, it, expect } from 'vitest';
import { polyfit, polyval, fitRms, findHomography, applyHomography, gaussianPdf } from '../src/core/math';
import { createCalibration, imageToGrid, gridToImage, cellAt } from '../src/core/calibration';
import { estimateOrigin } from '../src/core/origin';
import { extractFeatures, classify } from '../src/core/tracker';
import type { Track, TrackPoint } from '../src/core/types';

function makeCal() {
  const cal = createCalibration({
    videoWidth: 960,
    videoHeight: 540,
    floors: 18,
    units: 4,
  });
  // 用规则矩形四角，消除梯形畸变便于断言
  cal.corners = {
    tl: { x: 0.1, y: 0.05 },
    tr: { x: 0.9, y: 0.05 },
    bl: { x: 0.1, y: 0.95 },
    br: { x: 0.9, y: 0.95 },
  };
  return cal;
}

describe('polyfit', () => {
  it('精确拟合二次函数', () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = xs.map((x) => 2 * x * x - 3 * x + 5);
    const c = polyfit(xs, ys, 2)!;
    expect(c[0]).toBeCloseTo(5, 6);
    expect(c[1]).toBeCloseTo(-3, 6);
    expect(c[2]).toBeCloseTo(2, 6);
    expect(polyval(c, 2.5)).toBeCloseTo(2 * 6.25 - 7.5 + 5, 6);
    expect(fitRms(xs, ys, c)).toBeCloseTo(0, 6);
  });

  it('点数不足返回 null', () => {
    expect(polyfit([1, 2], [1, 2], 2)).toBeNull();
  });
});

describe('homography', () => {
  it('四点透视映射往返一致', () => {
    const cal = makeCal();
    const g0 = { u: 2.3, v: 7.8 };
    const p = gridToImage(cal, g0);
    const g1 = imageToGrid(cal, p);
    expect(g1.u).toBeCloseTo(g0.u, 5);
    expect(g1.v).toBeCloseTo(g0.v, 5);
  });

  it('角点映射到网格边界', () => {
    const cal = makeCal();
    const tl = imageToGrid(cal, cal.corners.tl);
    expect(tl.u).toBeCloseTo(0, 5);
    expect(tl.v).toBeCloseTo(18, 5);
    const br = imageToGrid(cal, cal.corners.br);
    expect(br.u).toBeCloseTo(4, 5);
    expect(br.v).toBeCloseTo(0, 5);
  });

  it('退化点集返回 null', () => {
    const p = { x: 0, y: 0 };
    expect(findHomography([p, p, p, p], [p, p, p, p])).toBeNull();
    const H = findHomography(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
      ],
    )!;
    expect(applyHomography(H, { x: 0.5, y: 0.5 })).toEqual({ x: 1, y: 1 });
  });
});

describe('cellAt', () => {
  it('定位到正确楼层与户号', () => {
    const cal = makeCal();
    // 单元 (floor=10, unit=2) 中心
    const p = gridToImage(cal, { u: 2.5, v: 10.5 });
    const hit = cellAt(cal, p);
    expect(hit.floorIndex).toBe(10);
    expect(hit.unitIndex).toBe(2);
    expect(hit.clamped).toBe(false);
  });

  it('越界点钳制到最近单元', () => {
    const cal = makeCal();
    const p = gridToImage(cal, { u: -0.6, v: 20.5 });
    const hit = cellAt(cal, p);
    expect(hit.unitIndex).toBe(0);
    expect(hit.floorIndex).toBe(17);
    expect(hit.clamped).toBe(true);
  });
});

describe('classify', () => {
  function trackFrom(points: TrackPoint[]): Track {
    const f = extractFeatures(points);
    return {
      id: 1,
      points,
      lastDetectionId: 0,
      missed: 0,
      kind: 'unknown',
      score: 0,
      features: f,
      closed: true,
      finalized: false,
    };
  }

  it('持续加速下落判为抛物', () => {
    const pts: TrackPoint[] = [];
    for (let i = 0; i < 12; i++) {
      const t = i * 0.05;
      pts.push({
        frame: i,
        timeSec: t,
        x: 100 + 30 * t,
        y: 50 + 200 * t + 600 * t * t,
      });
    }
    const tr = trackFrom(pts);
    tr.features.meanArea = 24;
    const v = classify(tr.features, 540);
    expect(v.kind).toBe('object');
    expect(v.score).toBeGreaterThan(0.45);
    expect(tr.features.accelY).toBeGreaterThan(200);
  });

  it('细小近匀速轨迹判为雨滴', () => {
    const pts: TrackPoint[] = [];
    for (let i = 0; i < 6; i++) {
      const t = i * 0.033;
      pts.push({ frame: i, timeSec: t, x: 200, y: 100 + 900 * t });
    }
    const tr = trackFrom(pts);
    tr.features.meanArea = 4;
    const v = classify(tr.features, 540);
    expect(v.kind).toBe('rain');
  });

  it('横向平移的小轨迹判为飞鸟', () => {
    const pts: TrackPoint[] = [];
    for (let i = 0; i < 10; i++) {
      const t = i * 0.05;
      pts.push({ frame: i, timeSec: t, x: 100 + 250 * t, y: 120 + Math.sin(t * 8) * 6 });
    }
    const tr = trackFrom(pts);
    tr.features.meanArea = 18;
    tr.features.areaCv = 0.6;
    const v = classify(tr.features, 540);
    expect(v.kind).toBe('bird');
  });

  it('曲折慢落轨迹判为树叶', () => {
    const pts: TrackPoint[] = [];
    for (let i = 0; i < 14; i++) {
      const t = i * 0.05;
      pts.push({
        frame: i,
        timeSec: t,
        x: 100 + Math.sin(t * 6) * 26,
        y: 100 + 55 * t + Math.sin(t * 9) * 10,
      });
    }
    const tr = trackFrom(pts);
    tr.features.meanArea = 16;
    tr.features.areaCv = 0.7;
    const v = classify(tr.features, 540);
    expect(v.kind).toBe('leaf');
  });
});

describe('estimateOrigin', () => {
  it('从合成抛物轨迹反推楼层户号误差不超过 1 层/1 户', () => {
    const cal = makeCal();
    const truthFloor = 14;
    const truthUnit = 2;
    const W = 960;
    const H = 540;
    // 模拟从 14 层 02 户抛出、在网格坐标中自由落体 0.8 秒的轨迹
    const g = 5.2;
    const pts: TrackPoint[] = [];
    for (let i = 0; i < 16; i++) {
      const t = 0.15 + i * 0.045; // 前 0.15 秒未进入画面，从 t=0.15 开始观测
      const u = truthUnit + 0.5 + 0.1 * t;
      const v = truthFloor + 0.55 - 0.5 * g * t * t;
      const img = gridToImage(cal, { u, v });
      pts.push({
        frame: i,
        timeSec: i * 0.045,
        x: img.x * W,
        y: img.y * H,
      });
    }
    const track: Track = {
      id: 1,
      points: pts,
      lastDetectionId: 0,
      missed: 0,
      kind: 'object',
      score: 0.9,
      features: extractFeatures(pts),
      closed: true,
      finalized: true,
    };
    const origin = estimateOrigin(track, cal, {
      analysisWidth: W,
      analysisHeight: H,
      windCompensation: 0.5,
    });
    expect(Math.abs(origin.cell.floorIndex - truthFloor)).toBeLessThanOrEqual(1);
    expect(Math.abs(origin.cell.unitIndex - truthUnit)).toBeLessThanOrEqual(1);
    expect(origin.confidence).toBeGreaterThan(0);
    expect(origin.floorProbabilities.length).toBeGreaterThan(0);
    expect(origin.unitProbabilities.length).toBeGreaterThan(0);
  });
});

describe('gaussianPdf', () => {
  it('均值处最大且对称', () => {
    expect(gaussianPdf(0, 0, 1)).toBeCloseTo(gaussianPdf(1, 1, 1), 9);
    expect(gaussianPdf(0, 0, 1)).toBeGreaterThan(gaussianPdf(1, 0, 1));
  });
});
