import type { Detection, Track, TrackFeatures, TrackKind, TrackPoint } from './types';

/** 从轨迹点提取分类特征（像素坐标，分析分辨率） */
export function extractFeatures(points: TrackPoint[]): TrackFeatures {
  const n = points.length;
  const first = points[0];
  const last = points[n - 1];
  const durationSec = Math.max(1e-6, last.timeSec - first.timeSec);
  const verticalDrop = last.y - first.y;
  const horizontalDrift = last.x - first.x;

  let pathLen = 0;
  let downSteps = 0;
  let vySum = 0;
  const ts: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    ts.push(points[i].timeSec - first.timeSec);
    ys.push(points[i].y);
    if (i > 0) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      pathLen += Math.hypot(dx, dy);
      if (dy > 0) downSteps++;
      const dt = Math.max(1e-6, points[i].timeSec - points[i - 1].timeSec);
      vySum += dy / dt;
    }
  }
  const netLen = Math.hypot(horizontalDrift, verticalDrop);
  const straightness = pathLen > 0 ? netLen / pathLen : 0;
  const downwardRatio = n > 1 ? downSteps / (n - 1) : 0;

  // 二次拟合 y(t)=a t²+b t+c，a 即重力项（像素/秒²）
  let accelY = 0;
  let fitRms = 0;
  if (n >= 4) {
    // 正规方程直接解二次
    const [a, b, c] = fitQuadratic(ts, ys);
    accelY = a;
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const r = ys[i] - (a * ts[i] * ts[i] + b * ts[i] + c);
      sse += r * r;
    }
    fitRms = Math.sqrt(sse / n);
  } else if (n >= 3) {
    const [a] = fitQuadratic(ts, ys);
    accelY = a;
  }

  return {
    durationSec,
    pointCount: n,
    verticalDrop,
    horizontalDrift,
    straightness,
    accelY,
    fitRms,
    downwardRatio,
    meanArea: 0,
    areaCv: 0,
    meanAspect: 1,
    meanVy: n > 1 ? vySum / (n - 1) : 0,
  };
}

/** 解 y = a t² + b t + c 的最小二乘系数 [a,b,c] */
function fitQuadratic(t: number[], y: number[]): [number, number, number] {
  let s0 = t.length;
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let sy = 0, sty = 0, st2y = 0;
  for (let i = 0; i < t.length; i++) {
    const ti = t[i];
    const t2 = ti * ti;
    s1 += ti;
    s2 += t2;
    s3 += t2 * ti;
    s4 += t2 * t2;
    sy += y[i];
    sty += ti * y[i];
    st2y += t2 * y[i];
  }
  // 高斯消元 3x3
  const M = [
    [s4, s3, s2, st2y],
    [s3, s2, s1, sty],
    [s2, s1, s0, sy],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

function statsFromSeries(areas: number[], aspects: number[]) {
  if (areas.length === 0) return { meanArea: 0, areaCv: 0, meanAspect: 1 };
  const meanArea = areas.reduce((a, b) => a + b, 0) / areas.length;
  const variance = areas.reduce((a, b) => a + (b - meanArea) ** 2, 0) / areas.length;
  const meanAspect = aspects.reduce((a, b) => a + b, 0) / aspects.length;
  return { meanArea, areaCv: meanArea > 0 ? Math.sqrt(variance) / meanArea : 0, meanAspect };
}

/**
 * 规则分类器。
 * 雨：短、小、近匀速直线、无重力加速度；
 * 鸟：横向为主、竖直位移小、面积波动大、可上升；
 * 树叶：路径曲折、面积/形态不稳、可向上飘、加速度弱或为负；
 * 抛物：持续下落 + 正向重力加速度 + 路径连贯。
 */
export function classify(
  features: TrackFeatures,
  frameHeight: number,
): { kind: TrackKind; score: number; reasons: string[] } {
  const f = features;
  const dropRatio = f.verticalDrop / frameHeight; // 相对画面高度的下落比例
  const reasons: string[] = [];

  // 排除项（优先于一切加分）
  const isRain =
    f.meanArea > 0 && f.meanArea <= 12 && f.durationSec < 0.5 && f.accelY < 120 && f.straightness > 0.9;
  const isBird =
    f.verticalDrop < frameHeight * 0.12 &&
    Math.abs(f.horizontalDrift) > Math.abs(f.verticalDrop) * 1.5 &&
    (f.areaCv > 0.45 || f.downwardRatio < 0.5);
  const isLeaf =
    f.straightness < 0.78 ||
    f.areaCv > 0.6 ||
    (f.accelY < 100 && f.downwardRatio < 0.92);

  if (isRain) {
    return { kind: 'rain', score: 0, reasons: ['小颗粒近匀速直线运动，判定为雨滴'] };
  }
  if (isBird) {
    return { kind: 'bird', score: 0, reasons: ['横向移动为主且形态波动，判定为飞鸟'] };
  }
  if (isLeaf) {
    return { kind: 'leaf', score: 0.05, reasons: ['路径曲折/形态不稳/无重力加速，判定为风吹树叶'] };
  }

  // 硬性物理门槛：真实高空抛物以显著、连贯、单向的下落为主判据。
  // 加速度受抽帧/帧差位置抖动影响大，仅作加分项而非硬门槛。
  // dropRatio≥0.35：真实坠落通常跨越画面三分之一以上，可滤楼面内短漂移噪声。
  // 时长上限 4s：真实坠落很快落地，跨全程（>4s）的连续"下落"几乎都是噪声关联链。
  // areaCv≤0.5：真实致密物体面积稳定；压缩噪声/碎片链面积剧烈波动（变异系数大）。
  const hardGates =
    dropRatio >= 0.35 &&
    f.downwardRatio >= 0.92 &&
    f.straightness >= 0.94 &&
    f.pointCount >= 10 &&
    f.durationSec >= 0.45 &&
    f.durationSec <= 4.0;
  if (!hardGates) {
    return { kind: 'unknown', score: 0.1, reasons: ['未同时满足下落距离/向下比/连贯度/时长硬门槛'] };
  }

  let score = 0;
  score += Math.min(0.3, f.downwardRatio * 0.3);
  score += Math.min(0.25, dropRatio * 0.5);
  if (f.accelY >= 150) { score += 0.2; reasons.push('存在正向重力加速度'); }
  else if (f.accelY >= 60) { score += 0.1; }
  score += f.straightness >= 0.95 ? 0.15 : 0.08;
  if (f.durationSec >= 0.6) score += 0.05;
  if (f.pointCount >= 14) score += 0.05;

  score = Math.min(1, score);
  reasons.push(`下落占画面 ${(dropRatio * 100).toFixed(0)}%、向下比 ${f.downwardRatio.toFixed(2)}、直线度 ${f.straightness.toFixed(2)}`);
  return { kind: 'object', score, reasons };
}

/** 多目标跟踪器：最近邻 + 速度预测的贪心关联 */
export class MultiTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  readonly maxMissed: number;
  private readonly maxMatchDistance: number;
  private lastTime = 0;

  constructor(opts: { maxMissedFrames: number; maxMatchDistance: number }) {
    this.maxMissed = opts.maxMissedFrames;
    this.maxMatchDistance = opts.maxMatchDistance;
  }

  get activeTracks(): Track[] {
    return this.tracks.filter((t) => !t.closed);
  }

  getAll(): Track[] {
    return this.tracks;
  }

  /**
   * 喂入一帧检测。Detection 的 cx/cy 为归一化坐标，这里按分析分辨率换算成像素，
   * 与 TrackPoint / 特征 / 抛物线反推的像素坐标系保持一致。
   * blobMetrics: detectionId → {area, aspect}，供形态特征汇总
   */
  update(
    detections: Detection[],
    blobMetrics: Map<number, { area: number; aspect: number }>,
    analysisSize: { width: number; height: number },
  ): void {
    const active = this.activeTracks;
    const usedDets = new Set<number>();
    const toPx = (d: Detection): { x: number; y: number } => ({
      x: d.cx * analysisSize.width,
      y: d.cy * analysisSize.height,
    });

    // 预测位置：用上一步速度外推
    const predicted = new Map<number, { x: number; y: number }>();
    for (const tr of active) {
      const n = tr.points.length;
      if (n >= 2) {
        const a = tr.points[n - 1];
        const b = tr.points[n - 2];
        predicted.set(tr.id, { x: a.x + (a.x - b.x), y: a.y + (a.y - b.y) });
      } else {
        predicted.set(tr.id, { x: tr.points[0].x, y: tr.points[0].y });
      }
    }

    // 代价矩阵贪心：每轮取全局最小匹配
    const pairs: { ti: number; di: number; cost: number }[] = [];
    for (let ti = 0; ti < active.length; ti++) {
      const pred = predicted.get(active[ti].id)!;
      for (let di = 0; di < detections.length; di++) {
        const p = toPx(detections[di]);
        const cost = Math.hypot(p.x - pred.x, p.y - pred.y);
        if (cost <= this.maxMatchDistance) pairs.push({ ti, di, cost });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);
    const matchedTracks = new Set<number>();
    for (const { ti, di } of pairs) {
      if (matchedTracks.has(ti) || usedDets.has(detections[di].id)) continue;
      matchedTracks.add(ti);
      usedDets.add(detections[di].id);
      const tr = active[ti];
      const d = detections[di];
      const px = toPx(d);
      tr.points.push({ frame: d.frame, timeSec: d.timeSec, x: px.x, y: px.y });
      tr.missed = 0;
      tr.lastDetectionId = d.id;
      const m = blobMetrics.get(d.id);
      if (m) {
        (tr as Track & { _areas?: number[]; _aspects?: number[] })._areas ??= [];
        (tr as Track & { _areas?: number[]; _aspects?: number[] })._aspects ??= [];
        (tr as Track & { _areas: number[] })._areas.push(m.area);
        (tr as Track & { _aspects: number[] })._aspects.push(m.aspect);
      }
    }

    // 未匹配轨迹：漏检计数，超过容忍窗口则闭合（不插入预测点，避免外推带偏后续关联）
    const frameTime = detections.length ? detections[0].timeSec : this.lastTime;
    this.lastTime = frameTime;
    for (const tr of active) {
      if (!matchedTracks.has(tr.id)) {
        tr.missed++;
        if (tr.missed > this.maxMissed) tr.closed = true;
      }
    }

    // 未匹配检测：新建轨迹
    for (const d of detections) {
      if (usedDets.has(d.id)) continue;
      const px = toPx(d);
      const tr: Track = {
        id: this.nextId++,
        points: [{ frame: d.frame, timeSec: d.timeSec, x: px.x, y: px.y }],
        lastDetectionId: d.id,
        missed: 0,
        kind: 'unknown',
        score: 0,
        features: extractFeatures([
          { frame: d.frame, timeSec: d.timeSec, x: px.x, y: px.y },
        ]),
        closed: false,
        finalized: false,
      };
      const m = blobMetrics.get(d.id);
      if (m) {
        (tr as Track & { _areas?: number[]; _aspects?: number[] })._areas = [m.area];
        (tr as Track & { _aspects?: number[] })._aspects = [m.aspect];
      }
      this.tracks.push(tr);
    }
  }

  /** 对单条轨迹做最终分类（幂等，已分类的直接返回缓存结果） */
  classifyOne(tr: Track, frameHeight: number): Track {
    if (tr.finalized) return tr;
    const features = extractFeatures(tr.points);
    const internal = tr as Track & { _areas?: number[]; _aspects?: number[] };
    if (internal._areas && internal._areas.length > 0) {
      const s = statsFromSeries(internal._areas, internal._aspects ?? []);
      features.meanArea = s.meanArea;
      features.areaCv = s.areaCv;
      features.meanAspect = s.meanAspect;
    }
    tr.features = features;
    const verdict = classify(features, frameHeight);
    tr.kind = verdict.kind;
    tr.score = verdict.score;
    tr.finalized = true;
    return tr;
  }

  /** 闭合轨迹后做最终分类，返回被判为目标的轨迹 */
  finalize(frameHeight: number, minDurationSec: number, minScore: number): Track[] {
    const objects: Track[] = [];
    for (const tr of this.tracks) {
      if (tr.points.length < 2) continue;
      this.classifyOne(tr, frameHeight);
      if (
        tr.kind === 'object' &&
        tr.features.durationSec >= minDurationSec &&
        tr.score >= minScore
      ) {
        objects.push(tr);
      }
    }
    return objects;
  }

  reset(): void {
    this.tracks = [];
    this.nextId = 1;
    this.lastTime = 0;
  }
}
