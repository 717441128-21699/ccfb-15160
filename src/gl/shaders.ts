/**
 * WebGL2 / GLSL ES 3.00 着色器源码
 * 管线：视频纹理 → 亮度+背景差分(MRT) → 阈值化 → 形态学 → 读回
 * 掩码纹理用 RGBA8 打包：R=二值掩码(0/255)，G=亮度(0..255)，形态学过程中 G 原样透传
 */

const VERT = /* glsl */ `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
void main() { gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0); }
`;

/** 视频纹理 → 亮度（BT.601） */
export const LUMA_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_frame;
out vec4 outColor;
void main() {
  vec3 c = texture(u_frame, gl_FragCoord.xy / vec2(textureSize(u_frame, 0))).rgb;
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  outColor = vec4(y, y, y, 1.0);
}
`;

/**
 * 背景建模 + 帧间差分 + 背景差分（三路融合，单输出，乒乓无反馈环）
 * 输出: R=融合差分(0..1) G=当前亮度；首帧强制零差分。
 * 帧差（|当前-上一帧|）无鬼影、精确定位运动物体当前位置；
 * 背景差（|当前-背景|）对缓慢/静止后启动的物体更敏感，两者取大值互补。
 */
export const BG_DIFF_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_luma;
uniform sampler2D u_bg;
uniform sampler2D u_prevLuma;
uniform bool u_firstFrame;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(u_luma, 0));
  float luma = texture(u_luma, uv).r;
  float bg = texture(u_bg, uv).r;
  float prevLuma = texture(u_prevLuma, uv).r;
  float bgDiff = abs(luma - bg);
  float frameDiff = abs(luma - prevLuma);
  // 纯帧间差分为主（无 EMA 鬼影）；背景差仅在物体短暂悬停（帧差≈0）时兜底，
  // 且必须显著超过阈值，避免把长尾巴重新引入。
  float hoverBoost = bgDiff * step(frameDiff + 0.05, 0.001);
  float diff = u_firstFrame ? 0.0 : max(frameDiff, hoverBoost);
  outColor = vec4(diff, luma, 0.0, 1.0);
}
`;

/**
 * 背景更新（EMA + 混合选择性更新，乒乓无反馈环）。
 * 上一帧掩码标记为运动区的像素用慢速学习（α×0.15），既能快速吸收陈旧轨迹、
 * 又不至于把当前帧的物体立刻学进背景；静止区按正常 α 学习光照变化。
 */
export const BG_UPDATE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_luma;
uniform sampler2D u_bg;
uniform sampler2D u_prevMask;
uniform float u_learnRate;
uniform bool u_firstFrame;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(u_luma, 0));
  float luma = texture(u_luma, uv).r;
  float bg = texture(u_bg, uv).r;
  float moving = texture(u_prevMask, uv).r;
  float rate = moving > 0.5 ? u_learnRate * 0.15 : u_learnRate;
  float newBg = u_firstFrame ? luma : mix(bg, luma, rate);
  outColor = vec4(newBg, newBg, newBg, 1.0);
}
`;

/** 阈值化：R 输出 0/1，G 透传亮度 */
export const THRESHOLD_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_diff;
uniform float u_threshold;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(u_diff, 0));
  vec4 s = texture(u_diff, uv);
  float mask = s.r > u_threshold ? 1.0 : 0.0;
  outColor = vec4(mask, s.g, 0.0, 1.0);
}
`;

/** 3x3 膨胀（对 R），G 取中心亮度透传 */
export const DILATE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_mask;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float m = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      m = max(m, texelFetch(u_mask, p + ivec2(dx, dy), 0).r);
    }
  }
  float luma = texelFetch(u_mask, p, 0).g;
  outColor = vec4(m, luma, 0.0, 1.0);
}
`;

/** 3x3 腐蚀（对 R），G 取中心亮度透传 */
export const ERODE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_mask;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float m = 1.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      m = min(m, texelFetch(u_mask, p + ivec2(dx, dy), 0).r);
    }
  }
  float luma = texelFetch(u_mask, p, 0).g;
  outColor = vec4(m, luma, 0.0, 1.0);
}
`;

export const FULLSCREEN_VERT = VERT;

/** 掩码拷贝（R 原样，G 透传亮度），用于把本帧掩码保存为“上一帧掩码” */
export const COPY_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_src;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(u_src, 0));
  outColor = texture(u_src, uv);
}
`;
