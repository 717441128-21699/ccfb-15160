// 算法层单元测试 + 精度仿真验证 (node 环境, 不依赖浏览器)
// 模拟合成视频的物理过程 -> 轨迹拟合 -> 回推 -> 楼层/户号判定, 统计精度指标
import type { Calibration, TrackPoint } from '../src/types';
import { bilinear, invBilinear, cellAt } from '../src/calib/geometry';
import { fitTrajectory, backProject } from '../src/detect/trajectory';
import { extractFeatures, classifyTrack } from '../src/detect/classify';

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

// ---------- 1. 几何: 双线性映射往返 ----------
{
  const calib = makeCalib();
  let maxErr = 0;
  for (let i = 0; i < 100; i++) {
    const u = Math.random(), v = Math.random();
    const p = bilinear(calib.quad, u, v);
    const [u2, v2] = invBilinear(calib.quad, p);
    maxErr = Math.max(maxErr, Math.abs(u - u2), Math.abs(v - v2));
  }
  ok(maxErr < 1e-6, `双线性映射往返误差 ${maxErr.toExponential(2)} < 1e-6`);
}

// ---------- 2. 抛物线拟合精度 ----------
{
  // 无噪声: 拟合应精确还原
  const pts: TrackPoint[] = [];
  for (let i = 0; i < 20; i++) {
    const t = i / 30;
    pts.push({ t, x: 0.5 + 0.1 * t, y: 0.2 + 0.05 * t + 0.105 * t * t, w: 0.01, h: 0.01, area: 20 });
  }
  const fit = fitTrajectory(pts)!;
  ok(Math.abs(fit.ay2 - 0.105) < 1e-6, `二次项还原 ay2=${fit.ay2.toFixed(6)}`);
  ok(fit.rms < 1e-9, `无噪声残差 rms=${fit.rms.toExponential(2)}`);
}

// ---------- 3. 端到端精度仿真: 多种物体 × 风速 ----------
function makeCalib(): Calibration {
  return {
    id: 'test', name: '测试楼', createdAt: 0, imageDataUrl: '', imgW: 1280, imgH: 720,
    quad: [{ x: 0.28, y: 0.03 }, { x: 0.72, y: 0.03 }, { x: 0.84, y: 0.97 }, { x: 0.16, y: 0.97 }],
    floors: 15, units: 4, startFloor: 2, unitOrder: 'ltr',
  };
}

const G = 0.21;
const OBJ = {
  bottle: { windK: 0.15, vTerm: 0.9, flutter: 0 },
  bag: { windK: 0.6, vTerm: 0.45, flutter: 0.15 },
  box: { windK: 1.0, vTerm: 0.35, flutter: 0.3 },
  paper: { windK: 1.6, vTerm: 0.22, flutter: 0.8 },
} as const;

function simulateThrow(calib: Calibration, row: number, col: number, wind: number,
  obj: keyof typeof OBJ, noise: number): TrackPoint[] {
  const c = OBJ[obj];
  const p0 = bilinear(calib.quad, (col + 0.5) / calib.units, (row + 0.5) / calib.floors);
  let x = p0.x, y = p0.y;
  let vx = (Math.random() - 0.5) * 0.04, vy = 0.01;
  const windN = c.windK * wind / 50;
  const pts: TrackPoint[] = [];
  const dt = 1 / 30;
  const phase = Math.random() * 6.28;
  for (let i = 0; i < 300; i++) {
    const t = i * dt;
    vy = Math.min(vy + G * dt, c.vTerm);
    vx += (windN - vx) * dt * 1.5;
    x += (vx + Math.sin(t * 5 + phase) * 0.01 * c.flutter) * dt;
    y += vy * dt;
    if (y > 0.99) break;
    pts.push({
      t, x: x + (Math.random() - 0.5) * noise, y: y + (Math.random() - 0.5) * noise,
      w: 0.01, h: 0.01, area: 20,
    });
  }
  return pts;
}

function e2e(noisePx: number, trials: number) {
  const calib = makeCalib();
  const noise = noisePx / 640; // 640×360 处理分辨率下定位噪声
  let n = 0, floorOk1 = 0, floorExact = 0, unitOk = 0, noBack = 0;
  const objs = Object.keys(OBJ) as (keyof typeof OBJ)[];
  for (let trial = 0; trial < trials; trial++) {
    const row = Math.floor(Math.random() * 13); // 3层及以上
    const col = Math.floor(Math.random() * calib.units);
    const wind = Math.random() * 8;
    const obj = objs[trial % objs.length];
    const pts = simulateThrow(calib, row, col, wind, obj, noise);
    const fit = fitTrajectory(pts);
    if (!fit) { noBack++; continue; }
    const back = backProject(fit, calib);
    if (!back) { noBack++; continue; }
    const cell = cellAt(calib, back.throwPoint);
    if (!cell) { noBack++; continue; }
    n++;
    const trueFloor = calib.startFloor + (calib.floors - 1 - row);
    const trueUnit = col + 1;
    if (Math.abs(cell.floor - trueFloor) <= 1) floorOk1++;
    if (cell.floor === trueFloor) floorExact++;
    if (cell.floor === trueFloor && cell.unit === trueUnit) unitOk++;
  }
  console.log(`\n端到端仿真 (${trials} 次随机抛物, 4 种物体, 风速 0~8m/s, ±${noisePx}px 噪声):`);
  console.log(`  有效回推: ${n}/${trials} (失败 ${noBack})`);
  console.log(`  楼层误差≤1层: ${(floorOk1 / n * 100).toFixed(1)}%  (要求 ≥ 接近100%)`);
  console.log(`  楼层完全正确: ${(floorExact / n * 100).toFixed(1)}%`);
  console.log(`  户号判对率:   ${(unitOk / n * 100).toFixed(1)}%  (要求 ≥ 90%)`);
  return { floorOk1: floorOk1 / n, unitOk: unitOk / n };
}
{
  const r2 = e2e(2, 400);
  ok(r2.floorOk1 >= 0.98, '±2px: 楼层误差≤1层比例 ≥ 98%');
  ok(r2.unitOk >= 0.9, '±2px: 户号判对率 ≥ 90%');
  const r4 = e2e(4, 400); // 更差定位条件下仍应达标
  ok(r4.floorOk1 >= 0.95, '±4px: 楼层误差≤1层比例 ≥ 95%');
  ok(r4.unitOk >= 0.9, '±4px: 户号判对率 ≥ 90%');
}

// ---------- 4. 分类器: 下落物/树叶/鸟/雨 ----------
{
  const mk = (fn: (t: number, i: number) => [number, number], n = 20, area = 20): TrackPoint[] =>
    Array.from({ length: n }, (_, i) => {
      const t = i / 30;
      const [x, y] = fn(t, i);
      return { t, x, y, w: 0.01, h: 0.01, area };
    });
  // 下落物
  const fall = extractFeatures(mk(t => [0.5 + 0.02 * t, 0.3 + 0.1 * t + 0.105 * t * t]));
  ok(classifyTrack(fall) === 'fall', '下落物 -> fall');
  // 树叶: 慢速下落 + 水平反复摇摆 (1.3 秒, 多次变向)
  const leaf = extractFeatures(mk(t => [0.5 + Math.sin(t * 8) * 0.05, 0.3 + 0.05 * t], 40));
  ok(classifyTrack(leaf) === 'leaf', '树叶 -> leaf');
  // 鸟: 水平飞
  const bird = extractFeatures(mk(t => [0.2 + 0.25 * t, 0.4 + Math.sin(t * 8) * 0.005]));
  ok(classifyTrack(bird) === 'bird', '飞鸟 -> bird');
  // 雨: 极快竖直, 短促, 目标小
  const rain = extractFeatures(mk(t => [0.5 + 0.005 * t, 0.1 + 1.2 * t], 8, 10));
  ok(classifyTrack(rain) === 'rain', '雨滴 -> rain');
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
