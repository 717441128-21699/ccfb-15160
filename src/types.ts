// 共享数据类型

/** 归一化图像坐标 (0..1, y 向下) */
export interface Pt { x: number; y: number }

/** 标定四边形角点顺序: 左上, 右上, 右下, 左下 */
export type Quad = [Pt, Pt, Pt, Pt];

export interface Calibration {
  id: string;
  name: string;
  createdAt: number;
  /** 标定参考图 (dataURL), 仅用于标定页显示与报告 */
  imageDataUrl: string;
  imgW: number;
  imgH: number;
  quad: Quad;
  floors: number;       // 楼层数
  units: number;        // 每层户数
  startFloor: number;   // 最底层对应的楼层号(如 2 表示从2楼开始)
  unitOrder: 'ltr' | 'rtl'; // 户号从左到右或从右到左
}

export function unitLabel(c: Calibration, floor: number, unit: number): string {
  return `${floor}${String(unit).padStart(2, '0')}`;
}

/** 轨迹采样点, t 为视频时间(秒), x/y 为归一化坐标 */
export interface TrackPoint {
  t: number;
  x: number;
  y: number;
  w: number;   // 目标框宽(归一化)
  h: number;
  area: number; // 像素面积(处理分辨率下)
}

export type TrackClass = 'fall' | 'leaf' | 'bird' | 'rain' | 'noise' | 'unknown';

export interface Track {
  id: number;
  points: TrackPoint[];
  cls: TrackClass;
}

export interface ThrowEvent {
  id: string;
  videoName: string;
  videoTime: number;      // 抛出时刻(视频时间, 秒)
  wallTime: number;       // 检测完成时的真实时间戳
  floor: number;
  unit: number;
  label: string;          // 户号, 如 "1502"
  confidence: number;     // 0..1
  throwPoint: Pt;         // 回推的抛出点(归一化坐标)
  trajectory: TrackPoint[];
  thumbnail: string;      // dataURL, 轨迹叠加截图
  calibrationId: string;
  objectGuess: string;    // 根据轨迹特征推测的物体类型
}

export interface GroundTruthEvent {
  t: number;        // 抛出时刻(秒)
  floor: number;
  unit: number;
  object: string;
  wind: number;     // m/s
}

export interface GroundTruth {
  video: string;
  events: GroundTruthEvent[];
}

export interface AccuracyReport {
  matched: number;
  missed: number;       // 真值中未检出的事件数
  falseAlarms: number;  // 检出了但真值没有的事件数
  floorExact: number;
  floorWithin1: number;
  unitCorrect: number;
}
