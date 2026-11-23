// 连通域提取(处理分辨率下的二值掩膜 -> 目标块)
export interface Blob {
  x: number; y: number;       // 质心(像素)
  minX: number; minY: number;
  maxX: number; maxY: number;
  area: number;
}

export function extractBlobs(mask: Uint8Array, w: number, h: number, minArea: number, maxArea: number): Blob[] {
  const labels = new Int32Array(w * h);
  let nextLabel = 0;
  const parent: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      const left = x > 0 ? labels[i - 1] : 0;
      const up = y > 0 ? labels[i - w] : 0;
      if (left && up) { labels[i] = left; union(left, up); }
      else labels[i] = left || up || (parent[nextLabel] = nextLabel, ++nextLabel);
    }
  }
  interface Acc { sx: number; sy: number; area: number; minX: number; minY: number; maxX: number; maxY: number }
  const acc = new Map<number, Acc>();
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const l = labels[i];
      if (!l) continue;
      const r = find(l);
      let a = acc.get(r);
      if (!a) { a = { sx: 0, sy: 0, area: 0, minX: x, minY: y, maxX: x, maxY: y }; acc.set(r, a); }
      a.sx += x; a.sy += y; a.area++;
      if (x < a.minX) a.minX = x; if (x > a.maxX) a.maxX = x;
      if (y < a.minY) a.minY = y; if (y > a.maxY) a.maxY = y;
    }
  }
  const out: Blob[] = [];
  for (const a of acc.values()) {
    if (a.area < minArea || a.area > maxArea) continue;
    out.push({
      x: a.sx / a.area, y: a.sy / a.area,
      minX: a.minX, minY: a.minY, maxX: a.maxX, maxY: a.maxY,
      area: a.area,
    });
  }
  return out;
}
