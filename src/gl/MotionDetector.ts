// WebGL2 运动检测管线: 灰度 -> 背景建模/帧差 -> 阈值 -> 形态学开运算 -> 掩膜回读

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){ vUV = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;

// 视频帧 -> 灰度 (夜间模式做 gamma 提亮)
const FRAG_LUMA = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform float uGamma;
in vec2 vUV;
out float o;
void main(){
  vec3 c = texture(uTex, vUV).rgb;
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  o = pow(y, uGamma);
}`;

// 背景差 + 帧差 -> 运动掩膜
// 掩膜 = (背景差>阈值 且 帧差>阈值) 或 (背景差>强阈值):
// 帧差确认可抗鬼影, 但刚抛出时物体慢速、帧差几乎为零, 强背景差分支保证慢速段可检
const FRAG_MASK = `#version 300 es
precision mediump float;
uniform sampler2D uCur, uBg, uPrev;
uniform float uTh;        // 背景差阈值
uniform float uThFrame;   // 帧差阈值
in vec2 vUV;
out float oMask;
void main(){
  float cur = texture(uCur, vUV).r;
  float bg  = texture(uBg, vUV).r;
  float prv = texture(uPrev, vUV).r;
  float dBg = abs(cur - bg);
  float dFr = abs(cur - prv);
  oMask = ((dBg > uTh && dFr > uThFrame) || dBg > uTh * 2.5) ? 1.0 : 0.0;
}`;

// 背景更新 (单独 pass, 避开 MRT 兼容性问题): 运动区域慢更新, 静止区域正常学习
const FRAG_BG = `#version 300 es
precision mediump float;
uniform sampler2D uCur, uBg, uMask;
uniform float uAlpha;
uniform float uInit;   // 首帧为 1.0: 强制直接用当前帧初始化背景
in vec2 vUV;
out float oBg;
void main(){
  float cur = texture(uCur, vUV).r;
  float bg  = texture(uBg, vUV).r;
  float m   = texture(uMask, vUV).r;
  float a = max(mix(uAlpha, uAlpha * 0.02, m), uInit);
  oBg = mix(bg, cur, a);
}`;

// 3x3 腐蚀 / 膨胀
const FRAG_ERODE = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uPx;
in vec2 vUV;
out float o;
void main(){
  float m = 1.0;
  for(int dy=-1; dy<=1; dy++)
    for(int dx=-1; dx<=1; dx++)
      m = min(m, texture(uTex, vUV + vec2(float(dx), float(dy)) * uPx).r);
  o = m;
}`;
const FRAG_DILATE = FRAG_ERODE.replace('float m = 1.0;', 'float m = 0.0;').replace('m = min(m,', 'm = max(m,');

export interface DetectorParams {
  threshold: number;   // 背景差阈值 0..1
  frameTh: number;     // 帧差阈值
  alpha: number;       // 背景学习率
  night: boolean;      // 夜间红外模式
  morph: boolean;      // 形态学开运算
}

export const DEFAULT_DETECTOR: DetectorParams = {
  threshold: 0.09, frameTh: 0.04, alpha: 0.02, night: false, morph: true,
};

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}

function program(gl: WebGL2RenderingContext, frag: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  return p;
}

function makeTex(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export class MotionDetector {
  readonly w: number;
  readonly h: number;
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private progLuma: WebGLProgram;
  private progMask: WebGLProgram;
  private progBg: WebGLProgram;
  private progErode: WebGLProgram;
  private progDilate: WebGLProgram;
  private videoTex: WebGLTexture;
  private cur: WebGLTexture[];   // 灰度 ping-pong (0=当前, 1=上一帧)
  private bg: WebGLTexture[];    // 背景 ping-pong
  private maskTex: WebGLTexture[]; // 形态学 ping-pong
  private fbo: WebGLFramebuffer;
  private readBuf: Uint8Array;
  private frameIdx = 0;
  params: DetectorParams;

  constructor(w: number, h: number, params: Partial<DetectorParams> = {}) {
    this.w = w; this.h = h;
    this.params = { ...DEFAULT_DETECTOR, ...params };
    this.canvas = document.createElement('canvas');
    this.canvas.width = w; this.canvas.height = h;
    const gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.progLuma = program(gl, FRAG_LUMA);
    this.progMask = program(gl, FRAG_MASK);
    this.progBg = program(gl, FRAG_BG);
    this.progErode = program(gl, FRAG_ERODE);
    this.progDilate = program(gl, FRAG_DILATE);
    // 全屏三角形
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.videoTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.cur = [makeTex(gl, w, h), makeTex(gl, w, h)];
    this.bg = [makeTex(gl, w, h), makeTex(gl, w, h)];
    this.maskTex = [makeTex(gl, w, h), makeTex(gl, w, h)];
    this.fbo = gl.createFramebuffer()!;
    this.readBuf = new Uint8Array(w * h);
  }

  private bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (loc) gl.uniform1i(loc, unit);
  }

  private drawTo(targets: (WebGLTexture | null)[]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const bufs: number[] = [];
    targets.forEach((t, i) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      if (t) bufs.push(gl.COLOR_ATTACHMENT0 + i);
    });
    gl.drawBuffers(bufs.length ? bufs : [gl.NONE]);
    gl.viewport(0, 0, this.w, this.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** 处理一帧(视频元素/画布), 返回二值掩膜 (w*h, 0/255) */
  process(src: TexImageSource): Uint8Array {
    const gl = this.gl;
    const p = this.params;
    const ci = this.frameIdx & 1;
    // 1. 上传视频帧并转灰度
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.useProgram(this.progLuma);
    gl.uniform1f(gl.getUniformLocation(this.progLuma, 'uGamma'), p.night ? 0.55 : 1.0);
    this.bindTex(0, this.videoTex, gl.getUniformLocation(this.progLuma, 'uTex'));
    this.drawTo([this.cur[ci]]);
    // 2. 背景差 + 帧差 -> mask
    gl.useProgram(this.progMask);
    gl.uniform1f(gl.getUniformLocation(this.progMask, 'uTh'), p.night ? p.threshold * 0.7 : p.threshold);
    gl.uniform1f(gl.getUniformLocation(this.progMask, 'uThFrame'), p.frameTh);
    this.bindTex(0, this.cur[ci], gl.getUniformLocation(this.progMask, 'uCur'));
    this.bindTex(1, this.bg[0], gl.getUniformLocation(this.progMask, 'uBg'));
    this.bindTex(2, this.cur[1 - ci], gl.getUniformLocation(this.progMask, 'uPrev'));
    this.drawTo([this.maskTex[0]]);
    // 2b. 背景更新 (独立 pass)
    gl.useProgram(this.progBg);
    gl.uniform1f(gl.getUniformLocation(this.progBg, 'uAlpha'),
      this.frameIdx < 30 ? 0.2 : p.alpha);
    gl.uniform1f(gl.getUniformLocation(this.progBg, 'uInit'), this.frameIdx === 0 ? 1.0 : 0.0);
    this.bindTex(0, this.cur[ci], gl.getUniformLocation(this.progBg, 'uCur'));
    this.bindTex(1, this.bg[0], gl.getUniformLocation(this.progBg, 'uBg'));
    this.bindTex(2, this.maskTex[0], gl.getUniformLocation(this.progBg, 'uMask'));
    this.drawTo([this.bg[1]]);
    [this.bg[0], this.bg[1]] = [this.bg[1], this.bg[0]];
    // 3. 形态学开运算 (腐蚀后膨胀)
    let maskTex = this.maskTex[0];
    if (p.morph) {
      const px = [1 / this.w, 1 / this.h];
      gl.useProgram(this.progErode);
      gl.uniform2f(gl.getUniformLocation(this.progErode, 'uPx'), px[0], px[1]);
      this.bindTex(0, maskTex, gl.getUniformLocation(this.progErode, 'uTex'));
      this.drawTo([this.maskTex[1]]);
      gl.useProgram(this.progDilate);
      gl.uniform2f(gl.getUniformLocation(this.progDilate, 'uPx'), px[0], px[1]);
      this.bindTex(0, this.maskTex[1], gl.getUniformLocation(this.progDilate, 'uTex'));
      this.drawTo([this.maskTex[0]]);
      maskTex = this.maskTex[0];
    }
    // 4. 回读
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, maskTex, 0);
    gl.readPixels(0, 0, this.w, this.h, gl.RED, gl.UNSIGNED_BYTE, this.readBuf);
    this.frameIdx++;
    return this.readBuf;
  }

  reset() { this.frameIdx = 0; }
}
