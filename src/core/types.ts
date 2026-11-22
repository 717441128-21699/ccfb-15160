/**
 * 全局领域模型：标定、检测、轨迹、事件、配置
 * 所有坐标除特别说明外，图像坐标均为归一化坐标（x,y ∈ [0,1]，原点左上，y 向下）。
 */

/** 二维向量 */
export interface Vec2 {
  x: number;
  y: number;
}

/** 楼面四角（归一化图像坐标），tl=左上 tr=右上 br=右下 bl=左下 */
export interface FacadeCorners {
  tl: Vec2;
  tr: Vec2;
  bl: Vec2;
  br: Vec2;
}

/** 楼面标定：网格 + 透视四角 + 楼层/户号命名 */
export interface FacadeCalibration {
  id: string;
  name: string;
  /** 视频/图像分辨率（标定基于该分辨率，坐标本身归一化） */
  videoWidth: number;
  videoHeight: number;
  corners: FacadeCorners;
  floors: number;
  units: number;
  /** 楼层标签，自下而上，长度 = floors；缺省为 1..floors */
  floorLabels: string[];
  /** 户号标签，自左而右，长度 = units；缺省为 01,02,... */
  unitLabels: string[];
  /** 仰角（度），仅用于物理尺度估计，不参与网格映射 */
  cameraElevationDeg: number;
  /** 夜间红外标定 */
  infrared: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 网格单元（楼层/户）引用，索引均从 0 开始 */
export interface CellRef {
  floorIndex: number;
  unitIndex: number;
  floorLabel: string;
  unitLabel: string;
}

/** 单帧检测到的运动连通域 */
export interface Detection {
  id: number;
  frame: number;
  timeSec: number;
  /** 质心（归一化） */
  cx: number;
  cy: number;
  /** 外接框（归一化） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 像素面积（分析分辨率下） */
  area: number;
  /** 前景占空比（面积/外接框面积） */
  fillRatio: number;
  /** 平均亮度 0..255 */
  meanLuma: number;
}

/** 轨迹点（轨迹内部使用像素坐标，分析分辨率） */
export interface TrackPoint {
  frame: number;
  timeSec: number;
  x: number;
  y: number;
}

export type TrackKind = 'object' | 'rain' | 'leaf' | 'bird' | 'unknown';

/** 一条被跟踪的运动轨迹 */
export interface Track {
  id: number;
  points: TrackPoint[];
  /** 最近一帧匹配到的检测 id */
  lastDetectionId: number;
  /** 连续漏检帧数 */
  missed: number;
  kind: TrackKind;
  /** 分类评分 0..1，越高越像抛物 */
  score: number;
  /** 分类特征（调试/取证展示用） */
  features: TrackFeatures;
  /** 轨迹是否已结束（漏检超限） */
  closed: boolean;
  /** 是否已完成最终分类（避免重复出事件） */
  finalized: boolean;
}

/** 轨迹分类特征 */
export interface TrackFeatures {
  durationSec: number;
  pointCount: number;
  /** 总竖直位移（像素，向下为正） */
  verticalDrop: number;
  /** 水平位移（像素，向右为正） */
  horizontalDrift: number;
  /** 路径直线度：净位移 / 路径长度，0..1 */
  straightness: number;
  /** 二次拟合 y(t)=a t²+b t+c 的 a（像素/秒²），重力项 */
  accelY: number;
  /** 拟合残差 RMS（像素） */
  fitRms: number;
  /** 竖直速度方向一致性（向下运动占比） */
  downwardRatio: number;
  /** 平均面积（分析分辨率像素） */
  meanArea: number;
  /** 面积变异系数 */
  areaCv: number;
  /** 平均长宽比 */
  meanAspect: number;
  /** 平均下落速度（像素/秒） */
  meanVy: number;
}

/** 抛出点反推结果 */
export interface OriginEstimate {
  /** 反推抛出点（归一化图像坐标） */
  point: Vec2;
  /** 命中的网格单元 */
  cell: CellRef;
  /** 相邻楼层/户号的概率分布（用于置信度展示） */
  floorProbabilities: { floorLabel: string; prob: number }[];
  unitProbabilities: { unitLabel: string; prob: number }[];
  /** 楼层索引标准差（单位：层） */
  floorSigma: number;
  /** 户号索引标准差（单位：户） */
  unitSigma: number;
  confidence: number;
  /** 反推到抛出时刻（秒，相对视频时间轴，可能为负表示首帧之前） */
  launchTimeSec: number;
  /** 估计的出手初速度（像素/秒，分析分辨率） */
  launchVelocity: Vec2;
  /** 拟合物理量 */
  gravityPx: number;
  fitRmsPx: number;
  /** 判定依据说明（人读） */
  reasons: string[];
}

/** 一起高空抛物事件 */
export interface ThrowEvent {
  id: string;
  calibrationId: string;
  videoName: string;
  /** 事件起始/结束时间（秒） */
  startSec: number;
  endSec: number;
  startFrame: number;
  endFrame: number;
  track: Track;
  origin: OriginEstimate;
  infrared: boolean;
  /** 关键帧截图（dataURL，缩略图） */
  thumbnails: string[];
  createdAt: number;
}

/** 分析参数（页面可调） */
export interface AnalysisConfig {
  /** 分析缩放：长边降到该像素，0 表示原分辨率 */
  maxAnalysisEdge: number;
  /** 抽帧步长（每 N 帧分析 1 帧） */
  frameStride: number;
  /** 抽帧模式：fast=快放+rVFC（默认，速度快），seek=逐帧跳转（兼容性好，慢而稳），auto=先 fast 异常自动回退 */
  frameMode: 'auto' | 'fast' | 'seek';
  /** 背景学习率 α（EMA） */
  backgroundLearnRate: number;
  /** 前景阈值（亮度差 0..255） */
  threshold: number;
  /** 最小连通域面积（分析分辨率像素） */
  minBlobArea: number;
  /** 最大连通域面积占画面比例 */
  maxBlobRatio: number;
  /** 轨迹关联的最大马氏距离（像素） */
  maxMatchDistance: number;
  /** 轨迹闭合漏帧数 */
  maxMissedFrames: number;
  /** 判定为抛物的最低评分 */
  minThrowScore: number;
  /** 最短轨迹时长（秒） */
  minTrackDurationSec: number;
  /** 夜间红外模式（自动/强制昼/强制夜） */
  nightMode: 'auto' | 'day' | 'night';
  /** 风偏补偿：水平方向抗漂移强度 0..1 */
  windCompensation: number;
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  maxAnalysisEdge: 960,
  frameStride: 2,
  frameMode: 'auto',
  backgroundLearnRate: 0.06,
  threshold: 28,
  minBlobArea: 25,
  maxBlobRatio: 0.12,
  maxMatchDistance: 90,
  maxMissedFrames: 10,
  minThrowScore: 0.65,
  minTrackDurationSec: 0.35,
  nightMode: 'auto',
  windCompensation: 0.2,
};

/** 一次完整视频分析的运行摘要 */
export interface AnalysisRunSummary {
  videoName: string;
  durationSec: number;
  processedFrames: number;
  skippedFrames: number;
  analysisWidth: number;
  analysisHeight: number;
  infrared: boolean;
  wallTimeMs: number;
  eventCount: number;
  trackCount: number;
}
