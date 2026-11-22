import type { Vec2 } from './types';

/**
 * 加权最小二乘多项式拟合 y = Σ c_i x^i
 * 用正规方程 + Cholesky 分解，阶数 ≤ 3 时数值稳定。
 * 返回系数 c（升幂），自由度不足时返回 null。
 */
export function polyfit(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  degree: number,
  weights?: ArrayLike<number>,
): number[] | null {
  const n = xs.length;
  if (n < degree + 1) return null;

  const w = (i: number) => (weights ? weights[i] : 1);
  // 幂次和 S_k = Σ w x^k
  const powSums = new Float64Array(2 * degree + 1);
  for (let k = 0; k <= 2 * degree; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += w(i) * Math.pow(xs[i], k);
    }
    powSums[k] = s;
  }
  // 右端项 b_k = Σ w x^k y
  const b = new Float64Array(degree + 1);
  for (let k = 0; k <= degree; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += w(i) * Math.pow(xs[i], k) * ys[i];
    }
    b[k] = s;
  }
  const A: number[][] = [];
  for (let r = 0; r <= degree; r++) {
    const row: number[] = [];
    for (let c = 0; c <= degree; c++) row.push(powSums[r + c]);
    A.push(row);
  }
  return solveLinear(A, Array.from(b));
}

/** 高斯消元解线性方程组（带部分主元） */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** 多项式求值（Horner） */
export function polyval(coeffs: ArrayLike<number>, x: number): number {
  let y = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) y = y * x + coeffs[i];
  return y;
}

/** 拟合残差 RMS */
export function fitRms(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  coeffs: ArrayLike<number>,
): number {
  let acc = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = ys[i] - polyval(coeffs, xs[i]);
    acc += d * d;
  }
  return Math.sqrt(acc / xs.length);
}

/**
 * 计算 3x3 单应矩阵 H，把 src 四点映射到 dst 四点（图像归一化坐标均可）。
 * 返回行主序 9 元素数组。
 */
export function findHomography(src: Vec2[], dst: Vec2[]): number[] | null {
  if (src.length < 4 || dst.length < 4) return null;
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i];
    const { x: xp, y: yp } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -xp * x, -xp * y]);
    b.push(xp);
    A.push([0, 0, 0, x, y, 1, -yp * x, -yp * y]);
    b.push(yp);
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** 用 3x3 行主序矩阵变换点 */
export function applyHomography(H: ArrayLike<number>, p: Vec2): Vec2 {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

/** 3x3 矩阵求逆（行主序），奇异返回 null */
export function invertMat3(m: ArrayLike<number>): number[] | null {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const invDet = 1 / det;
  return [
    A * invDet,
    (c * h - b * i) * invDet,
    (b * f - c * e) * invDet,
    B * invDet,
    (a * i - c * g) * invDet,
    (c * d - a * f) * invDet,
    C * invDet,
    (b * g - a * h) * invDet,
    (a * e - b * d) * invDet,
  ];
}

/** 样本均值/标准差 */
export function meanStd(xs: ArrayLike<number>): { mean: number; std: number } {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  const mean = s / xs.length;
  let v = 0;
  for (let i = 0; i < xs.length; i++) v += (xs[i] - mean) ** 2;
  return { mean, std: Math.sqrt(v / xs.length) };
}

/** 高斯概率密度（未归一化也可，调用方自行归一化） */
export function gaussianPdf(x: number, mu: number, sigma: number): number {
  if (sigma < 1e-9) return Math.abs(x - mu) < 1e-9 ? 1 : 0;
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
