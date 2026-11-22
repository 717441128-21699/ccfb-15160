import {
  FULLSCREEN_VERT,
  LUMA_FRAG,
  BG_DIFF_FRAG,
  BG_UPDATE_FRAG,
  THRESHOLD_FRAG,
  DILATE_FRAG,
  ERODE_FRAG,
  COPY_FRAG,
} from './shaders';

/** 连通域（分析分辨率像素坐标，原点左上） */
export interface RawBlob {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  area: number;
  fillRatio: number;
  meanLuma: number;
}

export interface ProcessResult {
  blobs: RawBlob[];
  /** 整帧平均亮度，用于昼夜判断 */
  meanLuma: number;
  gpuMs: number;
  ccMs: number;
}

interface RenderTarget {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('无法创建着色器');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`着色器编译失败: ${log}`);
  }
  return sh;
}

function makeProgram(gl: WebGL2RenderingContext, fragSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('无法创建程序');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`程序链接失败: ${log}`);
  }
  return prog;
}

function makeTarget(gl: WebGL2RenderingContext, w: number, h: number): RenderTarget {
  const tex = gl.createTexture();
  if (!tex) throw new Error('无法创建纹理');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('无法创建 FBO');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo };
}

/**
 * WebGL2 运动检测器
 * GPU：亮度 → EMA 背景建模/差分(MRT) → 阈值 → 形态学
 * CPU：readPixels 后两遍法连通域（并查集）
 */
export class GlMotionDetector {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private width = 0;
  private height = 0;
  private firstFrame = true;

  private progLuma: WebGLProgram;
  private progBgDiff: WebGLProgram;
  private progBgUpdate: WebGLProgram;
  private progThresh: WebGLProgram;
  private progDilate: WebGLProgram;
  private progErode: WebGLProgram;
  private progCopy: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private inputTex: WebGLTexture;

  private lumaRt!: RenderTarget;
  private prevLumaRt!: RenderTarget; // 上一帧亮度，供帧间差分
  private diffRt!: RenderTarget; // att0 差分
  private bgRtA!: RenderTarget; // 背景乒乓缓冲 A
  private bgRtB!: RenderTarget; // 背景乒乓缓冲 B
  private bgIndex = 0; // 当前可读背景（0=A）
  private maskRt!: RenderTarget;
  private prevMaskRt!: RenderTarget; // 上一帧二值掩码，供选择性背景更新
  private workA!: RenderTarget;
  private workB!: RenderTarget;

  private pixels!: Uint8Array;
  private labels!: Int32Array;
  private parent!: Int32Array;
  private statArea!: Int32Array;
  private statSumX!: Float64Array;
  private statSumY!: Float64Array;
  private statMinX!: Int32Array;
  private statMinY!: Int32Array;
  private statMaxX!: Int32Array;
  private statMaxY!: Int32Array;
  private statLuma!: Float64Array;
  private labelCount = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', {
      preserveDrawingBuffer: false,
      antialias: false,
      alpha: false,
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.progLuma = makeProgram(gl, LUMA_FRAG);
    this.progBgDiff = makeProgram(gl, BG_DIFF_FRAG);
    this.progBgUpdate = makeProgram(gl, BG_UPDATE_FRAG);
    this.progThresh = makeProgram(gl, THRESHOLD_FRAG);
    this.progDilate = makeProgram(gl, DILATE_FRAG);
    this.progErode = makeProgram(gl, ERODE_FRAG);
    this.progCopy = makeProgram(gl, COPY_FRAG);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('无法创建 VAO');
    this.vao = vao;
    const inputTex = gl.createTexture();
    if (!inputTex) throw new Error('无法创建输入纹理');
    this.inputTex = inputTex;
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
  }

  static isSupported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch {
      return false;
    }
  }

  get dimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    this.disposeTargets();
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.lumaRt = makeTarget(gl, w, h);
    this.prevLumaRt = makeTarget(gl, w, h);
    this.diffRt = makeTarget(gl, w, h);
    this.bgRtA = makeTarget(gl, w, h);
    this.bgRtB = makeTarget(gl, w, h);
    this.bgIndex = 0;
    this.workA = makeTarget(gl, w, h);
    this.workB = makeTarget(gl, w, h);
    this.maskRt = makeTarget(gl, w, h);
    this.prevMaskRt = makeTarget(gl, w, h);
    const n = w * h;
    this.pixels = new Uint8Array(n * 4);
    this.labels = new Int32Array(n);
    this.parent = new Int32Array(n);
    this.statArea = new Int32Array(n);
    this.statSumX = new Float64Array(n);
    this.statSumY = new Float64Array(n);
    this.statMinX = new Int32Array(n);
    this.statMinY = new Int32Array(n);
    this.statMaxX = new Int32Array(n);
    this.statMaxY = new Int32Array(n);
    this.statLuma = new Float64Array(n);
    this.reset();
  }

  reset(): void {
    this.firstFrame = true;
    this.bgIndex = 0;
  }

  private disposeTargets(): void {
    const gl = this.gl;
    for (const rt of [
      this.lumaRt, this.prevLumaRt, this.diffRt, this.bgRtA, this.bgRtB,
      this.maskRt, this.prevMaskRt, this.workA, this.workB,
    ]) {
      if (!rt) continue;
      gl.deleteTexture(rt.tex);
      gl.deleteFramebuffer(rt.fbo);
    }
  }

  private uniform(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    return this.gl.getUniformLocation(prog, name);
  }

  private drawTo(target: RenderTarget | null): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, this.width, this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * 处理一帧。source 为当前视频帧（HTMLVideoElement / canvas）。
   * 注意：上传不做 Y 翻转，readPixels 行序自下而上，连通域内做行号换算。
   */
  processFrame(
    source: TexImageSource,
    opts: { learnRate: number; threshold: number; erode: boolean; dilate?: boolean; dilatePasses?: number },
  ): ProcessResult {
    const gl = this.gl;
    const t0 = performance.now();
    const { width: w, height: h } = this;

    // 1. 上传视频帧
    gl.bindTexture(gl.TEXTURE_2D, this.inputTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    // 2. 亮度
    gl.useProgram(this.progLuma);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inputTex);
    gl.uniform1i(this.uniform(this.progLuma, 'u_frame'), 0);
    this.drawTo(this.lumaRt);

    // 3a. 背景更新：读旧背景（readRt），写新背景（writeRt），乒乓无反馈环
    const readRt = this.bgIndex === 0 ? this.bgRtA : this.bgRtB;
    const writeRt = this.bgIndex === 0 ? this.bgRtB : this.bgRtA;
    gl.useProgram(this.progBgUpdate);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lumaRt.tex);
    gl.uniform1i(this.uniform(this.progBgUpdate, 'u_luma'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, readRt.tex);
    gl.uniform1i(this.uniform(this.progBgUpdate, 'u_bg'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.prevMaskRt.tex);
    gl.uniform1i(this.uniform(this.progBgUpdate, 'u_prevMask'), 2);
    gl.uniform1f(this.uniform(this.progBgUpdate, 'u_learnRate'), opts.learnRate);
    gl.uniform1i(this.uniform(this.progBgUpdate, 'u_firstFrame'), this.firstFrame ? 1 : 0);
    this.drawTo(writeRt);

    // 3b. 差分：背景差与帧间差取大值（帧差消除鬼影，背景差补灵敏度）
    gl.useProgram(this.progBgDiff);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lumaRt.tex);
    gl.uniform1i(this.uniform(this.progBgDiff, 'u_luma'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, readRt.tex);
    gl.uniform1i(this.uniform(this.progBgDiff, 'u_bg'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.prevLumaRt.tex);
    gl.uniform1i(this.uniform(this.progBgDiff, 'u_prevLuma'), 2);
    gl.uniform1i(this.uniform(this.progBgDiff, 'u_firstFrame'), this.firstFrame ? 1 : 0);
    this.drawTo(this.diffRt);

    // 新背景成为下一帧的可读背景
    this.bgIndex = this.bgIndex === 0 ? 1 : 0;
    this.firstFrame = false;

    // 4. 阈值化
    gl.useProgram(this.progThresh);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.diffRt.tex);
    gl.uniform1i(this.uniform(this.progThresh, 'u_diff'), 0);
    gl.uniform1f(this.uniform(this.progThresh, 'u_threshold'), opts.threshold / 255);
    this.drawTo(this.maskRt);

    // 4b. 保存本帧二值掩码作为下一帧的“上一帧掩码”（选择性背景更新用）
    gl.useProgram(this.progCopy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.maskRt.tex);
    gl.uniform1i(this.uniform(this.progCopy, 'u_src'), 0);
    this.drawTo(this.prevMaskRt);

    // 4c. 保存本帧亮度作为下一帧的“上一帧亮度”（帧间差分用）
    gl.bindTexture(gl.TEXTURE_2D, this.lumaRt.tex);
    gl.uniform1i(this.uniform(this.progCopy, 'u_src'), 0);
    this.drawTo(this.prevLumaRt);

    // 5. 形态学：先腐蚀去噪点；仅在需要桥接断裂时膨胀。
    //    默认只腐蚀，避免每帧无条件膨胀使运动区逐帧外扩形成"长大鬼影"。
    let readTarget: RenderTarget = this.maskRt;
    if (opts.erode) {
      gl.useProgram(this.progErode);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTarget.tex);
      gl.uniform1i(this.uniform(this.progErode, 'u_mask'), 0);
      this.drawTo(this.workA);
      readTarget = this.workA;
    }
    if (opts.dilate) {
      const passes = Math.max(1, opts.dilatePasses ?? 1);
      for (let p = 0; p < passes; p++) {
        gl.useProgram(this.progDilate);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, readTarget.tex);
        gl.uniform1i(this.uniform(this.progDilate, 'u_mask'), 0);
        // workA/workB 乒乓，避免读写同一纹理
        const dst = p % 2 === 0 ? this.workB : this.workA;
        this.drawTo(dst);
        readTarget = dst;
      }
    }

    // 6. 读回（RGBA；经纹理采样后行序已与源图像一致）
    gl.bindFramebuffer(gl.FRAMEBUFFER, readTarget.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    const gpuMs = performance.now() - t0;

    const t1 = performance.now();
    const blobs = this.connectedComponents();
    const ccMs = performance.now() - t1;
    return { blobs, meanLuma: this.frameMeanLuma, gpuMs, ccMs };
  }

  private frameMeanLuma = 0;

  /** 两遍法连通域，输入为 this.pixels（R=掩码 0/255，G=亮度） */
  private connectedComponents(): RawBlob[] {
    const { width: w, height: h, pixels, labels, parent } = this;
    labels.fill(0);
    this.labelCount = 0;
    let lumaSum = 0;

    const findRoot = (x: number): number => {
      let r = x;
      while (parent[r] !== r) r = parent[r];
      let c = x;
      while (parent[c] !== c) {
        const next = parent[c];
        parent[c] = r;
        c = next;
      }
      return r;
    };
    const union = (a: number, b: number): void => {
      const ra = findRoot(a);
      const rb = findRoot(b);
      if (ra !== rb) {
        if (ra < rb) parent[rb] = ra;
        else parent[ra] = rb;
      }
    };
    const newLabel = (): number => {
      const id = ++this.labelCount;
      parent[id] = id;
      return id;
    };

    // 第一遍：8 邻域标记（在 GL 行空间，连通性与翻转无关）
    for (let r = 0; r < h; r++) {
      const rowBase = r * w * 4;
      for (let c = 0; c < w; c++) {
        const idx4 = rowBase + c * 4;
        lumaSum += pixels[idx4 + 1];
        if (pixels[idx4] === 0) continue;
        const idx = r * w + c;
        const neighbors: number[] = [];
        if (c > 0 && labels[idx - 1] !== 0) neighbors.push(labels[idx - 1]);
        if (r > 0) {
          if (labels[idx - w] !== 0) neighbors.push(labels[idx - w]);
          if (c > 0 && labels[idx - w - 1] !== 0) neighbors.push(labels[idx - w - 1]);
          if (c < w - 1 && labels[idx - w + 1] !== 0) neighbors.push(labels[idx - w + 1]);
        }
        if (neighbors.length === 0) {
          labels[idx] = newLabel();
        } else {
          let min = neighbors[0];
          for (let k = 1; k < neighbors.length; k++) {
            if (neighbors[k] < min) min = neighbors[k];
          }
          labels[idx] = min;
          for (const nb of neighbors) union(min, nb);
        }
      }
    }
    this.frameMeanLuma = lumaSum / (w * h);

    // 第二遍：汇总统计（坐标换算到图像行空间 y = h-1-r）
    const n = this.labelCount + 1;
    this.statArea.fill(0, 0, n);
    this.statSumX.fill(0, 0, n);
    this.statSumY.fill(0, 0, n);
    this.statLuma.fill(0, 0, n);
    for (let i = 0; i < n; i++) {
      this.statMinX[i] = w;
      this.statMinY[i] = h;
      this.statMaxX[i] = -1;
      this.statMaxY[i] = -1;
    }
    for (let r = 0; r < h; r++) {
      // 纹理采样已完成 GL 行序到图像行序的翻转，readPixels 第 r 行即图像第 r 行，
      // 这里不再做 h-1-r 翻转，否则 y 轴双重反转会让下落变成上升。
      const y = r;
      const rowBase = r * w * 4;
      for (let c = 0; c < w; c++) {
        const idx = r * w + c;
        const lab = labels[idx];
        if (lab === 0) continue;
        const root = findRoot(lab);
        this.statArea[root]++;
        this.statSumX[root] += c;
        this.statSumY[root] += y;
        this.statLuma[root] += pixels[rowBase + c * 4 + 1];
        if (c < this.statMinX[root]) this.statMinX[root] = c;
        if (c > this.statMaxX[root]) this.statMaxX[root] = c;
        if (y < this.statMinY[root]) this.statMinY[root] = y;
        if (y > this.statMaxY[root]) this.statMaxY[root] = y;
      }
    }

    const blobs: RawBlob[] = [];
    for (let id = 1; id <= this.labelCount; id++) {
      if (parent[id] !== id) continue; // 非根
      const area = this.statArea[id];
      if (area === 0) continue;
      const bx = this.statMinX[id];
      const by = this.statMinY[id];
      const bw = this.statMaxX[id] - bx + 1;
      const bh = this.statMaxY[id] - by + 1;
      blobs.push({
        x: bx,
        y: by,
        w: bw,
        h: bh,
        cx: this.statSumX[id] / area,
        cy: this.statSumY[id] / area,
        area,
        fillRatio: area / (bw * bh),
        meanLuma: this.statLuma[id] / area,
      });
    }
    return blobs;
  }

  dispose(): void {
    this.disposeTargets();
    this.gl.deleteTexture(this.inputTex);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.progLuma);
    this.gl.deleteProgram(this.progBgDiff);
    this.gl.deleteProgram(this.progBgUpdate);
    this.gl.deleteProgram(this.progThresh);
    this.gl.deleteProgram(this.progDilate);
    this.gl.deleteProgram(this.progErode);
    this.gl.deleteProgram(this.progCopy);
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}
