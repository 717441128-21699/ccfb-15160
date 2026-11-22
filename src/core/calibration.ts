import type { FacadeCalibration, Vec2, CellRef } from './types';
import { applyHomography, findHomography, invertMat3, clamp } from './math';

/** 网格坐标：u 为横向户号方向 [0,units]，v 为纵向楼层方向 [0,floors]，自下而上 */
export interface GridCoord {
  u: number;
  v: number;
}

/** 图像归一化坐标 → 楼面网格坐标 */
export function imageToGrid(cal: FacadeCalibration, p: Vec2): GridCoord {
  const H = buildImageToGrid(cal);
  const q = applyHomography(H, p);
  return { u: q.x, v: q.y };
}

/** 楼面网格坐标 → 图像归一化坐标 */
export function gridToImage(cal: FacadeCalibration, g: GridCoord): Vec2 {
  const H = buildGridToImage(cal);
  return applyHomography(H, { x: g.u, y: g.v });
}

function buildImageToGrid(cal: FacadeCalibration): number[] {
  const { corners, floors, units } = cal;
  const src = [corners.tl, corners.tr, corners.bl, corners.br];
  const dst: Vec2[] = [
    { x: 0, y: floors },
    { x: units, y: floors },
    { x: 0, y: 0 },
    { x: units, y: 0 },
  ];
  const H = findHomography(src, dst);
  if (!H) throw new Error('楼面四角共线，无法建立透视映射');
  return H;
}

function buildGridToImage(cal: FacadeCalibration): number[] {
  const H = buildImageToGrid(cal);
  const inv = invertMat3(H);
  if (!inv) throw new Error('透视矩阵不可逆');
  return inv;
}

/** 网格坐标是否在楼面范围内 */
export function isInsideFacade(cal: FacadeCalibration, g: GridCoord): boolean {
  return g.u >= 0 && g.u <= cal.units && g.v >= 0 && g.v <= cal.floors;
}

/**
 * 定位点所属网格单元。越界时按最近单元钳制（抛出点反推允许略出边界），
 * 用 clamped 标识是否发生了钳制。
 */
export function cellAt(
  cal: FacadeCalibration,
  p: Vec2,
): CellRef & { grid: GridCoord; clamped: boolean } {
  const g = imageToGrid(cal, p);
  const clamped = !isInsideFacade(cal, g);
  const fi = clamp(Math.floor(g.v), 0, cal.floors - 1);
  const ui = clamp(Math.floor(g.u), 0, cal.units - 1);
  return {
    floorIndex: fi,
    unitIndex: ui,
    floorLabel: cal.floorLabels[fi],
    unitLabel: cal.unitLabels[ui],
    grid: g,
    clamped,
  };
}

/** 单元四角（归一化图像坐标），顺序 tl tr br bl */
export function cellCorners(
  cal: FacadeCalibration,
  floorIndex: number,
  unitIndex: number,
): [Vec2, Vec2, Vec2, Vec2] {
  const u0 = unitIndex;
  const u1 = unitIndex + 1;
  const v0 = floorIndex;
  const v1 = floorIndex + 1;
  return [
    gridToImage(cal, { u: u0, v: v1 }),
    gridToImage(cal, { u: u1, v: v1 }),
    gridToImage(cal, { u: u1, v: v0 }),
    gridToImage(cal, { u: u0, v: v0 }),
  ];
}

export function cellCenter(cal: FacadeCalibration, floorIndex: number, unitIndex: number): Vec2 {
  return gridToImage(cal, { u: unitIndex + 0.5, v: floorIndex + 0.5 });
}

/** 全部网格线（叠加层绘制用），横线 floors+1 条、竖线 units+1 条，每条为归一化点序列 */
export function gridLines(cal: FacadeCalibration): { horizontal: Vec2[][]; vertical: Vec2[][] } {
  const horizontal: Vec2[][] = [];
  for (let f = 0; f <= cal.floors; f++) {
    horizontal.push([
      gridToImage(cal, { u: 0, v: f }),
      gridToImage(cal, { u: cal.units, v: f }),
    ]);
  }
  const vertical: Vec2[][] = [];
  for (let u = 0; u <= cal.units; u++) {
    vertical.push([
      gridToImage(cal, { u, v: 0 }),
      gridToImage(cal, { u, v: cal.floors }),
    ]);
  }
  return { horizontal, vertical };
}

/** 楼面外轮廓（归一化坐标） */
export function facadeOutline(cal: FacadeCalibration): Vec2[] {
  return [cal.corners.tl, cal.corners.tr, cal.corners.br, cal.corners.bl];
}

/** 生成缺省标定对象 */
export function createCalibration(partial: {
  videoWidth: number;
  videoHeight: number;
  floors: number;
  units: number;
  name?: string;
  infrared?: boolean;
}): FacadeCalibration {
  const { videoWidth: W, videoHeight: H, floors, units } = partial;
  // 缺省四角：画面内收 8% 的梯形（模拟仰拍楼面）
  const insetX = 0.08;
  const insetTop = 0.06;
  const insetBottom = 0.12;
  const now = Date.now();
  return {
    id: `cal_${now.toString(36)}`,
    name: partial.name ?? '1号楼南面',
    videoWidth: W,
    videoHeight: H,
    corners: {
      tl: { x: insetX, y: insetTop },
      tr: { x: 1 - insetX, y: insetTop },
      bl: { x: insetBottom, y: 1 - 0.04 },
      br: { x: 1 - insetBottom, y: 1 - 0.04 },
    },
    floors,
    units,
    floorLabels: Array.from({ length: floors }, (_, i) => `${i + 1}层`),
    unitLabels: Array.from({ length: units }, (_, i) => `${i + 1}`.padStart(2, '0')),
    cameraElevationDeg: 30,
    infrared: partial.infrared ?? false,
    createdAt: now,
    updatedAt: now,
  };
}
