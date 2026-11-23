// 调试: 定位户号误判的来源
import type { Calibration, TrackPoint } from '../src/types';
import { bilinear, cellAt, invBilinear } from '../src/calib/geometry';
import { fitTrajectory, backProject } from '../src/detect/trajectory';

const calib: Calibration = {
  id: 'test', name: 't', createdAt: 0, imageDataUrl: '', imgW: 1280, imgH: 720,
  quad: [{ x: 0.28, y: 0.03 }, { x: 0.72, y: 0.03 }, { x: 0.84, y: 0.97 }, { x: 0.16, y: 0.97 }],
  floors: 15, units: 4, startFloor: 2, unitOrder: 'ltr',
};
const G = 0.21;
const OBJ = {
  bottle: { windK: 0.15, vTerm: 0.9, flutter: 0 },
  bag: { windK: 0.6, vTerm: 0.45, flutter: 0.15 },
  box: { windK: 1.0, vTerm: 0.35, flutter: 0.3 },
  paper: { windK: 1.6, vTerm: 0.22, flutter: 0.8 },
} as const;

function sim(row: number, col: number, wind: number, obj: keyof typeof OBJ, noise: number): TrackPoint[] {
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
    pts.push({ t, x: x + (Math.random() - 0.5) * noise, y: y + (Math.random() - 0.5) * noise, w: 0.01, h: 0.01, area: 20 });
  }
  return pts;
}

const noise = 2 / 640;
const objs = Object.keys(OBJ) as (keyof typeof OBJ)[];
const failBy: Record<string, number> = {};
const totBy: Record<string, number> = {};
let worstBack = 0;
for (let trial = 0; trial < 400; trial++) {
  const row = Math.floor(Math.random() * 13);
  const col = Math.floor(Math.random() * calib.units);
  const wind = Math.random() * 8;
  const obj = objs[trial % objs.length];
  const pts = sim(row, col, wind, obj, noise);
  const fit = fitTrajectory(pts)!;
  const back = backProject(fit, calib);
  if (!back) { failBy[`${obj}_noback`] = (failBy[`${obj}_noback`] || 0) + 1; continue; }
  const cell = cellAt(calib, back.throwPoint);
  const trueFloor = calib.startFloor + (calib.floors - 1 - row);
  const trueUnit = col + 1;
  worstBack = Math.max(worstBack, back.backDistance);
  const key = obj;
  totBy[key] = (totBy[key] || 0) + 1;
  if (!cell || cell.floor !== trueFloor || cell.unit !== trueUnit) {
    failBy[key] = (failBy[key] || 0) + 1;
    if (trial < 20 || Math.random() < 0.1) {
      const p0 = bilinear(calib.quad, (col + 0.5) / calib.units, (row + 0.5) / calib.floors);
      const [uT] = invBilinear(calib.quad, p0);
      const [uE, vE] = invBilinear(calib.quad, back.throwPoint);
      console.log(`fail ${obj} row=${row} col=${col} wind=${wind.toFixed(1)} back=${back.backDistance.toFixed(2)}s ` +
        `u: ${uT.toFixed(3)}->${uE.toFixed(3)} v->${vE.toFixed(3)} got=${cell ? `${cell.floor}/${cell.unit}` : 'null'} want=${trueFloor}/${trueUnit} npts=${pts.length}`);
    }
  }
}
console.log('totals:', totBy);
console.log('fails:', failBy);
console.log('worst backDistance:', worstBack.toFixed(2));
