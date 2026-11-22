import type {
  FacadeCalibration,
  OriginEstimate,
  Track,
  Vec2,
  CellRef,
} from './types';
import { imageToGrid, gridToImage, cellAt } from './calibration';
import { gaussianPdf, polyfit, polyval, fitRms, meanStd, clamp } from './math';

export interface OriginOptions {
  /** 分析分辨率宽高（轨迹像素坐标基于该分辨率） */
  analysisWidth: number;
  analysisHeight: number;
  /** 风偏补偿 0..1：削弱水平外推中的匀速漂移项 */
  windCompensation: number;
}

/**
 * 由轨迹反推抛出点。
 * 思路：
 * 1. 轨迹点经透视映射进入楼面网格坐标 (u=户向, v=层向，自下而上)；
 * 2. 网格内分别拟合 v(t)=a t²+b t+c、u(t)=d t+e；
 * 3. 沿抛物线回溯到楼面顶部 v=floors（或首帧之前固定时长），得到抛出网格坐标；
 * 4. 按拟合残差折算楼层/户号不确定度，输出相邻单元概率分布。
 */
export function estimateOrigin(
  track: Track,
  cal: FacadeCalibration,
  opts: OriginOptions,
): OriginEstimate {
  const pts = track.points;
  const t0 = pts[0].timeSec;

  // 像素 → 归一化 → 网格
  const samples = pts.map((p) => {
    const norm: Vec2 = { x: p.x / opts.analysisWidth, y: p.y / opts.analysisHeight };
    const g = imageToGrid(cal, norm);
    return { t: p.timeSec - t0, u: g.u, v: g.v };
  });

  // 稳健拟合：先全量二次/线性拟合，再迭代剔除残差超过 2σ 的离群点（检测碎片/邻近噪声），
  // 最多迭代 2 轮且保留至少 60% 的点，避免把真实弯曲轨迹误删。
  let inliers = samples;
  for (let iter = 0; iter < 2; iter++) {
    const tsI = inliers.map((s) => s.t);
    const vFitI = polyfit(tsI, inliers.map((s) => s.v), 2);
    if (!vFitI || inliers.length <= 6) break;
    const resid = inliers.map((s) => Math.abs(s.v - polyval(vFitI, s.t)));
    const { mean, std } = meanStd(resid);
    const limit = Math.max(0.4, mean + 2 * std); // 网格层单位，至少容忍 0.4 层
    const kept = inliers.filter((_, i) => resid[i] <= limit);
    if (kept.length < samples.length * 0.6 || kept.length === inliers.length) break;
    inliers = kept;
  }

  const ts = inliers.map((s) => s.t);
  const us = inliers.map((s) => s.u);
  const vs = inliers.map((s) => s.v);

  const vFit = polyfit(ts, vs, 2) ?? [0, 0, vs[0]];
  const uFit = polyfit(ts, us, 1) ?? [0, us[0]];
  const vRms = fitRms(ts, vs, vFit);
  const uRms = fitRms(ts, us, uFit);

  // polyfit 返回升幂系数 [c, b, a]
  const [c, b, a] = vFit;
  // polyfit 线性拟合返回升幂系数 [e, d]；d 保留用于估计出手水平速度
  const [, d0] = uFit;
  // 风偏补偿：水平漂移斜率按比例收缩（风造成的整体平移不等于出手速度）
  const d = d0 * (1 - clamp(opts.windCompensation, 0, 1) * 0.7);

  // 回溯时刻：在两个候选间择优。
  //  候选 A：抛物线顶点（竖直速度归零），适合出手后先升后落；
  //  候选 B：观测起点再外推一个短时间（0.15s），适合出手即带向下初速度。
  // seek 抽帧噪声会使拟合加速度偏小、顶点不可靠，故用"是否落在合理楼层范围"来裁决。
  const vertexT = Math.abs(a) > 1e-9 ? -b / (2 * a) : 0;
  const span = Math.max(0.2, ts[ts.length - 1]);
  const maxBack = Math.min(1.0, Math.max(0.25, span));
  const candA = clamp(vertexT, -maxBack, 0);
  const candB = clamp(-0.15, -maxBack, 0);

  const gridVAt = (t: number): number => a * t * t + b * t + c;
  const vA = gridVAt(candA);
  const vB = gridVAt(candB);
  // 合理出手楼层：[2, floors]（排除底层和楼顶以上）
  const inRange = (v: number): boolean => v >= 1.5 && v <= cal.floors + 0.5;
  let launchT: number;
  if (inRange(vA) && (!inRange(vB) || Math.abs(candA) <= Math.abs(candB) + 0.05)) {
    launchT = candA;
  } else if (inRange(vB)) {
    launchT = candB;
  } else {
    // 都越界时取更接近楼面中部的
    launchT = Math.abs(vA - cal.floors / 2) <= Math.abs(vB - cal.floors / 2) ? candA : candB;
  }

  // 竖直方向按抛物线外推到出手时刻。
  const launchV = a * launchT * launchT + b * launchT + c;
  // 水平方向：户号归属取观测轨迹水平位置的中位数（对风偏/外推噪声稳健），
  // 而非沿 u(t) 线性外推——后者在 launchT<0 时会把户号系统性拉偏。
  const sortedU = [...us].sort((p, q) => p - q);
  const medianU = sortedU[Math.floor(sortedU.length / 2)];
  const launchU = medianU;
  const launchGrid = { u: launchU, v: launchV };
  const launchImage = gridToImage(cal, launchGrid);

  // 不确定度：残差 + 外推距离放缩（外推越远越不可靠）。
  // 下限取 0.6 层 / 0.5 户，使相邻单元始终获得可观概率，避免对噪声轨迹过度自信。
  const extrapFactor = 1 + Math.abs(launchT) / span;
  const floorSigma = Math.max(0.6, vRms * extrapFactor);
  const unitSigma = Math.max(0.5, uRms * extrapFactor);

  const hit = cellAt(cal, launchImage);
  const cell: CellRef = {
    floorIndex: hit.floorIndex,
    unitIndex: hit.unitIndex,
    floorLabel: hit.floorLabel,
    unitLabel: hit.unitLabel,
  };

  // 相邻单元概率（高斯截断到 ±2σ 范围，再归一化）
  const floorDist = distributionAround(
    hit.floorIndex,
    floorSigma,
    cal.floors,
    (i) => cal.floorLabels[i],
  );
  const unitDist = distributionAround(
    hit.unitIndex,
    unitSigma,
    cal.units,
    (i) => cal.unitLabels[i],
  );
  const floorProbabilities = floorDist.map((r) => ({ floorLabel: r.label, prob: r.prob }));
  const unitProbabilities = unitDist.map((r) => ({ unitLabel: r.label, prob: r.prob }));

  // 置信度：命中单元概率 × 轨迹质量
  const topFloorProb = floorProbabilities[0]?.prob ?? 0;
  const topUnitProb = unitProbabilities[0]?.prob ?? 0;
  const quality = clamp(track.score, 0, 1);
  const confidence = clamp(topFloorProb * topUnitProb * (0.6 + 0.4 * quality), 0, 1);

  // 出手速度（网格单位/秒 → 像素/秒）
  const launchVelocity = {
    x: d * opts.analysisWidth,
    y: (2 * a * launchT + b) * opts.analysisHeight * -1, // 图像 y 向下，网格 v 向上
  };

  const reasons: string[] = [];
  reasons.push(`网格内抛物线拟合残差 楼层 ${vRms.toFixed(2)} 层 / 户号 ${uRms.toFixed(2)} 户`);
  reasons.push(`沿拟合抛物线回溯 ${Math.abs(launchT).toFixed(2)} 秒至出手点（竖直速度归零处）`);
  if (hit.clamped) reasons.push('抛出点略出楼面边界，已按最近单元钳制');
  if (opts.windCompensation > 0) reasons.push('已施加风偏补偿，削弱水平匀速漂移影响');

  return {
    point: launchImage,
    cell,
    floorProbabilities,
    unitProbabilities,
    floorSigma,
    unitSigma,
    confidence,
    launchTimeSec: t0 + launchT,
    launchVelocity,
    gravityPx: 2 * a * opts.analysisHeight,
    fitRmsPx: vRms * opts.analysisHeight,
    reasons,
  };
}

function distributionAround(
  center: number,
  sigma: number,
  count: number,
  label: (i: number) => string,
): { label: string; prob: number }[] {
  const lo = Math.max(0, Math.floor(center - 2 * sigma));
  const hi = Math.min(count - 1, Math.ceil(center + 2 * sigma));
  const raw: { idx: number; w: number }[] = [];
  let sum = 0;
  for (let i = lo; i <= hi; i++) {
    // 用单元中心参与高斯计算
    const w = gaussianPdf(i + 0.5, center + 0.5, sigma);
    raw.push({ idx: i, w });
    sum += w;
  }
  if (sum === 0) {
    return [{ label: label(center), prob: 1 }];
  }
  return raw
    .map((r) => ({ label: label(r.idx), prob: r.w / sum }))
    .sort((p, q) => q.prob - p.prob);
}
