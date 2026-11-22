import { GlMotionDetector } from '../src/gl/detector';
import { MultiTracker } from '../src/core/tracker';

const canvas = document.getElementById('src') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const logEl = document.getElementById('log')!;
const lines: string[] = [];
const log = (s: string): void => {
  lines.push(s);
  logEl.textContent = lines.join('\n');
};

const W = canvas.width;
const H = canvas.height;
const detector = new GlMotionDetector();
detector.resize(W, H);
const tracker = new MultiTracker({ maxMissedFrames: 6, maxMatchDistance: 90 });

const drawFrame = (f: number): void => {
  // 静态背景
  ctx.fillStyle = '#202830';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#3a4654';
  for (let i = 0; i < 8; i++) ctx.fillRect(20 + i * 55, 40, 36, 26); // 静态窗户
  // 下落物体（第 3 帧进入，持续到第 40 帧），带重力加速度的真实抛物
  if (f >= 3 && f <= 40) {
    const t = (f - 3) / 25; // 秒
    const y = 30 + 120 * t + 0.5 * 520 * t * t; // 初速 120px/s，加速度 520px/s²
    ctx.fillStyle = '#ff5252';
    ctx.beginPath();
    ctx.arc(240, y, 9, 0, Math.PI * 2);
    ctx.fill();
  }
};

let totalBlobs = 0;
let framesWithBlobs = 0;
for (let f = 0; f < 48; f++) {
  drawFrame(f);
  const result = detector.processFrame(canvas, { learnRate: 0.06, threshold: 28 / 255, erode: true, dilate: true, dilatePasses: 2 });
  const valid = result.blobs.filter((b) => b.area >= 6);
  if (valid.length) {
    framesWithBlobs++;
    totalBlobs += valid.length;
    const biggest = [...valid].sort((a, b) => b.area - a.area)[0];
    log(`帧${String(f).padStart(2)}: n=${valid.length} 最大blob c=(${biggest.cx.toFixed(0)},${biggest.cy.toFixed(0)}) area=${biggest.area}`);
  }
  // 喂给跟踪器（归一化坐标）
  const detections = valid.map((b, i) => ({
    id: f * 100 + i,
    frame: f,
    timeSec: f / 25,
    cx: b.cx / W,
    cy: b.cy / H,
    x: b.x / W,
    y: b.y / H,
    w: b.w / W,
    h: b.h / H,
    area: b.area,
    fillRatio: b.fillRatio,
    meanLuma: b.meanLuma,
  }));
  const metrics = new Map(detections.map((d) => [d.id, { area: d.area, aspect: 1 }]));
  tracker.update(detections, metrics, { width: W, height: H });
}
for (const tr of tracker.activeTracks) tr.closed = true;
const objects = tracker.finalize(H, 0.25, 0.45);
log('———— 汇总 ————');
log(`有 blob 的帧=${framesWithBlobs}/48，blob 总数=${totalBlobs}`);
log(`跟踪器轨迹总数=${tracker.getAll().length}，判为抛物=${objects.length}`);
for (const o of tracker.getAll()) {
  const f = o.features;
  log(
    `轨迹#${o.id} kind=${o.kind} score=${o.score.toFixed(2)} 点数=${o.points.length} ` +
      `时长=${f.durationSec.toFixed(2)}s 下落=${f.verticalDrop.toFixed(0)}px ` +
      `accelY=${f.accelY.toFixed(0)} 直线度=${f.straightness.toFixed(2)} 向下比=${f.downwardRatio.toFixed(2)} ` +
      `meanVy=${f.meanVy.toFixed(0)} areaCv=${f.areaCv.toFixed(2)} meanArea=${f.meanArea.toFixed(0)}`,
  );
}
(window as unknown as { __GL_DEBUG_DONE: boolean }).__GL_DEBUG_DONE = true;
log('DONE');
