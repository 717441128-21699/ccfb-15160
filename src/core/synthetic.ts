import type { FacadeCalibration } from './types';
import { gridToImage } from './calibration';

export type SyntheticObjectKind = 'bottle' | 'apple' | 'bag' | 'brick' | 'phone';
export type InterfererKind = 'leaf' | 'bird' | 'rain';

export interface SyntheticThrow {
  kind: SyntheticObjectKind;
  /** 抛出楼层索引（0 起） */
  floorIndex: number;
  /** 抛出户号索引（0 起） */
  unitIndex: number;
  /** 出手初速度水平分量（网格单位/秒，向右为正） */
  vx: number;
  /** 出手初速度竖直分量（网格单位/秒，向上为正） */
  vy: number;
  /** 开始时间（秒） */
  startSec: number;
}

export interface SyntheticInterferer {
  kind: InterfererKind;
  count: number;
}

export interface SyntheticVideoConfig {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  calibration: FacadeCalibration;
  /** 风速等级 0..3（0 无风，3 强风） */
  windLevel: number;
  throws: SyntheticThrow[];
  interferers: SyntheticInterferer[];
  infrared: boolean;
  seed: number;
}

export interface GroundTruthEvent {
  floorIndex: number;
  unitIndex: number;
  floorLabel: string;
  unitLabel: string;
  kind: SyntheticObjectKind;
  startSec: number;
  endSec: number;
}

export interface SyntheticResult {
  blob: Blob;
  mimeType: string;
  extension: string;
  groundTruth: GroundTruthEvent[];
  config: SyntheticVideoConfig;
}

/** 可种子化的伪随机数（mulberry32），保证测试可复现 */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }
}

const GRAVITY_GRID = 5.2; // 网格 v 单位（层）/秒²，楼面 18 层约对应 54m，等效 g≈9.8

interface ActiveBody {
  throw: SyntheticThrow;
  t: number;
  u: number;
  v: number;
  x: number;
  y: number;
  size: number;
  alive: boolean;
  endSec: number;
}

interface LeafState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  size: number;
}
interface BirdState {
  x: number;
  y: number;
  vx: number;
  phase: number;
  size: number;
}
interface RainState {
  x: number;
  y: number;
  vy: number;
  len: number;
}

const OBJECT_COLORS: Record<SyntheticObjectKind, string> = {
  bottle: '#3b82f6',
  apple: '#dc2626',
  bag: '#d97706',
  brick: '#78716c',
  phone: '#111827',
};

export async function generateSyntheticVideo(
  cfg: SyntheticVideoConfig,
  onProgress?: (p: number) => void,
): Promise<SyntheticResult> {
  const { width: W, height: H, fps, durationSec, calibration: cal } = cfg;
  const rng = new Rng(cfg.seed);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // 风：基础水平速度（像素/秒），风速等级映射
  const windPx = [0, 26, 55, 95][cfg.windLevel] ?? 0;
  const gust = () => windPx * (0.75 + 0.5 * rng.next());

  // 初始化干扰物
  const leaves: LeafState[] = [];
  const leafCfg = cfg.interferers.find((i) => i.kind === 'leaf');
  for (let i = 0; i < (leafCfg?.count ?? 0); i++) {
    leaves.push({
      x: rng.range(0, W),
      y: rng.range(-H * 0.2, H),
      vx: rng.range(10, 40),
      vy: rng.range(15, 55),
      phase: rng.range(0, Math.PI * 2),
      size: rng.range(4, 9),
    });
  }
  const birds: BirdState[] = [];
  const birdCfg = cfg.interferers.find((i) => i.kind === 'bird');
  for (let i = 0; i < (birdCfg?.count ?? 0); i++) {
    birds.push({
      x: rng.range(-W * 0.2, W),
      y: rng.range(H * 0.05, H * 0.55),
      vx: rng.range(120, 220) * (rng.next() > 0.5 ? 1 : -1),
      phase: rng.range(0, Math.PI * 2),
      size: rng.range(7, 12),
    });
  }
  const rainDensity = cfg.interferers.find((i) => i.kind === 'rain')?.count ?? 0;
  const rain: RainState[] = [];
  for (let i = 0; i < rainDensity * 12; i++) {
    rain.push({
      x: rng.range(0, W),
      y: rng.range(-H, H),
      vy: rng.range(900, 1300),
      len: rng.range(8, 16),
    });
  }

  // 抛物事件调度
  const bodies: ActiveBody[] = [];
  const groundTruth: GroundTruthEvent[] = [];
  for (const th of cfg.throws) {
    const start = gridToImage(cal, { u: th.unitIndex + 0.5, v: th.floorIndex + 0.55 });
    const sizePx = { bottle: 13, apple: 11, bag: 15, brick: 12, phone: 10 }[th.kind];
    bodies.push({
      throw: th,
      t: 0,
      u: th.unitIndex + 0.5,
      v: th.floorIndex + 0.55,
      x: start.x * W,
      y: start.y * H,
      size: sizePx,
      alive: false,
      endSec: 0,
    });
  }

  // 预生成固定传感器噪点（静态，不随帧变化）
  const fixedNoise: Array<{ x: number; y: number }> = Array.from(
    { length: cfg.infrared ? 240 : 60 },
    () => ({ x: rng.next() * W, y: rng.next() * H }),
  );

  const drawFacade = (time: number): void => {
    // 背景天空/夜景
    if (cfg.infrared) {
      ctx.fillStyle = '#0b0f14';
    } else {
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#9fc5e8');
      grad.addColorStop(1, '#dce6f2');
      ctx.fillStyle = grad;
    }
    ctx.fillRect(0, 0, W, H);

    // 楼体
    const pts = [cal.corners.tl, cal.corners.tr, cal.corners.br, cal.corners.bl].map((p) => [
      p.x * W,
      p.y * H,
    ]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = cfg.infrared ? '#1c2530' : '#c9c2b4';
    ctx.fill();
    ctx.strokeStyle = cfg.infrared ? '#3a4a5c' : '#8f887b';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 窗户网格
    for (let f = 0; f < cal.floors; f++) {
      for (let u = 0; u < cal.units; u++) {
        const [tl, tr, br, bl] = [
          gridToImage(cal, { u: u + 0.12, v: f + 0.18 }),
          gridToImage(cal, { u: u + 0.88, v: f + 0.18 }),
          gridToImage(cal, { u: u + 0.88, v: f + 0.82 }),
          gridToImage(cal, { u: u + 0.12, v: f + 0.82 }),
        ];
        ctx.beginPath();
        ctx.moveTo(tl.x * W, tl.y * H);
        ctx.lineTo(tr.x * W, tr.y * H);
        ctx.lineTo(br.x * W, br.y * H);
        ctx.lineTo(bl.x * W, bl.y * H);
        ctx.closePath();
        const lit = ((f * 7 + u * 13) % 11) < 3;
        ctx.fillStyle = cfg.infrared
          ? lit
            ? '#2e3d4d'
            : '#141b23'
          : lit
            ? '#f5e6b8'
            : '#7d8fa3';
        ctx.fill();
      }
    }
    // 固定传感器噪点：预生成、每帧画在同一位置，属于静态背景，不产生帧间差。
    // （逐帧随机噪点会在 seek 抽帧下制造大量假运动，故改为静态。）
    ctx.fillStyle = cfg.infrared ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
    for (const dot of fixedNoise) {
      ctx.fillRect(dot.x, dot.y, 1.4, 1.4);
    }
    void time;
  };

  const drawBody = (b: ActiveBody): void => {
    const k = b.throw.kind;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.fillStyle = cfg.infrared ? '#e8eef5' : OBJECT_COLORS[k];
    if (k === 'apple') {
      ctx.beginPath();
      ctx.arc(0, 0, b.size * 0.55, 0, Math.PI * 2);
      ctx.fill();
    } else if (k === 'bottle') {
      ctx.fillRect(-b.size * 0.28, -b.size * 0.6, b.size * 0.56, b.size * 1.2);
    } else if (k === 'bag') {
      ctx.beginPath();
      ctx.moveTo(-b.size * 0.5, -b.size * 0.4);
      ctx.lineTo(b.size * 0.5, -b.size * 0.4);
      ctx.lineTo(b.size * 0.4, b.size * 0.6);
      ctx.lineTo(-b.size * 0.4, b.size * 0.6);
      ctx.closePath();
      ctx.fill();
    } else if (k === 'brick') {
      ctx.fillRect(-b.size * 0.6, -b.size * 0.4, b.size * 1.2, b.size * 0.8);
    } else {
      ctx.fillRect(-b.size * 0.45, -b.size * 0.6, b.size * 0.9, b.size * 1.2);
    }
    ctx.restore();
  };

  const updateLeaves = (dt: number): void => {
    for (const lf of leaves) {
      lf.phase += dt * 3;
      lf.x += (gust() + lf.vx) * dt;
      lf.y += (lf.vy + Math.sin(lf.phase) * 22) * dt;
      if (lf.y > H + 12) {
        lf.y = -12;
        lf.x = rng.range(0, W);
      }
      if (lf.x > W + 12) lf.x = -12;
    }
  };
  const drawLeaves = (): void => {
    ctx.fillStyle = cfg.infrared ? '#9aa8b8' : '#4d7c0f';
    for (const lf of leaves) {
      ctx.save();
      ctx.translate(lf.x, lf.y);
      ctx.rotate(lf.phase);
      ctx.beginPath();
      ctx.ellipse(0, 0, lf.size * 0.6, lf.size * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  const updateBirds = (dt: number): void => {
    for (const bd of birds) {
      bd.phase += dt * 10;
      bd.x += bd.vx * dt;
      bd.y += Math.sin(bd.phase * 0.4) * 18 * dt;
      if (bd.vx > 0 && bd.x > W + 20) bd.x = -20;
      if (bd.vx < 0 && bd.x < -20) bd.x = W + 20;
    }
  };
  const drawBirds = (): void => {
    ctx.strokeStyle = cfg.infrared ? '#cfd8e3' : '#1f2937';
    ctx.lineWidth = 2;
    for (const bd of birds) {
      const flap = Math.sin(bd.phase) * bd.size * 0.5;
      ctx.beginPath();
      ctx.moveTo(bd.x - bd.size, bd.y + flap);
      ctx.quadraticCurveTo(bd.x, bd.y, bd.x, bd.y - 2);
      ctx.quadraticCurveTo(bd.x, bd.y, bd.x + bd.size, bd.y + flap);
      ctx.stroke();
    }
  };

  const updateRain = (dt: number): void => {
    for (const r of rain) {
      r.y += r.vy * dt;
      r.x += windPx * 0.35 * dt;
      if (r.y > H + 20) {
        r.y = -20;
        r.x = rng.range(0, W);
      }
    }
  };
  const drawRain = (): void => {
    ctx.strokeStyle = cfg.infrared ? 'rgba(200,215,235,0.55)' : 'rgba(120,150,190,0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const r of rain) {
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(r.x - windPx * 0.02, r.y - r.len);
    }
    ctx.stroke();
  };

  // 录制
  const mimeCandidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=h264',
    'video/webm;codecs=vp9',
    'video/webm',
  ];
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  if (!mimeType) throw new Error('浏览器不支持 MediaRecorder 视频编码');
  const stream = canvas.captureStream(fps);
  // 每帧手动 requestFrame：保证每帧被采集器取走、时间戳连续，
  // 避免仅靠 captureStream 自动采样在无头/低刷新环境产生重复帧或时长空洞。
  const videoTrack = stream.getVideoTracks()[0] as MediaStreamTrack & {
    requestFrame?: () => void;
  };
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 10_000_000,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });
  recorder.start(250);

  const totalFrames = Math.round(durationSec * fps);
  const dt = 1 / fps;
  const frameMs = 1000 / fps;
  // 固定墙钟节拍：保证录制时长 = 帧数 × 帧周期，避免 setTimeout(0) 造成时间戳空洞
  const waitTick = (): Promise<void> =>
    new Promise((resolve) => {
      const begin = performance.now();
      const spin = (): void => {
        if (performance.now() - begin >= frameMs - 2) resolve();
        else requestAnimationFrame(spin);
      };
      requestAnimationFrame(spin);
    });

  for (let frame = 0; frame < totalFrames; frame++) {
    const time = frame / fps;

    // 调度抛物
    for (const b of bodies) {
      if (!b.alive && time >= b.throw.startSec) {
        b.alive = true;
        b.t = 0;
      }
      if (b.alive) {
        b.t += dt;
        const th = b.throw;
        // 网格坐标下的抛物线（v 向上）
        b.u = th.unitIndex + 0.5 + th.vx * b.t + (windPx / W) * cal.units * 0.12 * b.t;
        b.v = th.floorIndex + 0.55 + th.vy * b.t - 0.5 * GRAVITY_GRID * b.t * b.t;
        const img = gridToImage(cal, { u: b.u, v: b.v });
        b.x = img.x * W;
        b.y = img.y * H;
        if (b.v <= 0 || b.y > H + 24) {
          b.alive = false;
          b.endSec = time;
          if (!groundTruth.some((g) => g.startSec === th.startSec && g.kind === th.kind)) {
            groundTruth.push({
              floorIndex: th.floorIndex,
              unitIndex: th.unitIndex,
              floorLabel: cal.floorLabels[th.floorIndex],
              unitLabel: cal.unitLabels[th.unitIndex],
              kind: th.kind,
              startSec: th.startSec,
              endSec: b.endSec,
            });
          }
        }
      }
    }

    updateLeaves(dt);
    updateBirds(dt);
    updateRain(dt);

    drawFacade(time);
    drawRain();
    drawLeaves();
    drawBirds();
    for (const b of bodies) if (b.alive) drawBody(b);

    // 红外画面整体灰度化 + 轻微暗角
    if (cfg.infrared) {
      const imgData = ctx.getImageData(0, 0, W, H);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const gray = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
        d[i] = gray * 0.85;
        d[i + 1] = gray * 0.95;
        d[i + 2] = gray * 1.08;
      }
      ctx.putImageData(imgData, 0, 0);
    }

    videoTrack.requestFrame?.();
    onProgress?.((frame + 1) / totalFrames);
    await waitTick();
  }

  // 等最后一帧被采集器取走再停止，避免尾部丢帧导致 duration 偏短
  await waitTick();
  recorder.stop();
  const blob = await done;
  const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
  return {
    blob,
    mimeType,
    extension,
    groundTruth,
    config: cfg,
  };
}
