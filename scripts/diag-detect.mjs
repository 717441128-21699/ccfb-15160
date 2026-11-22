/**
 * 检测链路探针 v2：
 *  - 录制含下落物体的视频后，用 seek 逐帧回放（绕开无头环境不可靠的 rVFC）
 *  - 直接 import 真实 GlMotionDetector，打印每帧 blob 数量与面积
 */
import { chromium } from 'playwright-core';
import { existsSync, writeFileSync } from 'node:fs';

const EDGE = existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
page.on('console', (m) => console.log('[browser]', m.text()));
await page.goto('http://localhost:5317/', { waitUntil: 'networkidle' });

// 在页面里动态 import 构建产物中的检测器模块（需用相对路径）
const moduleUrl = '/assets/' + (await page.evaluate(async () => {
  const html = await fetch('/').then((r) => r.text());
  return (html.match(/assets\/(index-[^"]+\.js)/) || [])[1] || '';
}));

const probe = await page.evaluate(async (modUrl) => {
  const mod = await import(modUrl);
  const steps = [];
  // 模块被打包，GlMotionDetector 可能未导出到入口；用 window 兜底检查
  steps.push(`module keys: ${Object.keys(mod).slice(0, 20).join(',')}`);

  const W = 480, H = 270;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const mime = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));

  const rec = new MediaRecorder(canvas.captureStream(25), { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = () => r()));
  rec.start(200);
  for (let f = 0; f < 50; f++) {
    ctx.fillStyle = '#202830';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(40, 30, 60, 50);
    const y = 20 + f * 3.2;
    ctx.fillStyle = '#ff3030';
    ctx.beginPath(); ctx.arc(240, y, 9, 0, Math.PI * 2); ctx.fill();
    await new Promise((r) => {
      const begin = performance.now();
      const spin = () => (performance.now() - begin >= 38 ? r() : requestAnimationFrame(spin));
      requestAnimationFrame(spin);
    });
  }
  await new Promise((r) => setTimeout(r, 80));
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: mime });
  steps.push(`recorder blob=${blob.size}B mime=${mime}`);

  const v = document.createElement('video');
  v.muted = true; v.playsInline = true;
  v.src = URL.createObjectURL(blob);
  await new Promise((r) => (v.onloadedmetadata = r));
  steps.push(`duration=${v.duration} ${v.videoWidth}x${v.videoHeight}`);

  // seek 逐帧 + 朴素帧差（不依赖打包内部类，验证数据通路）
  const ac = document.createElement('canvas');
  ac.width = W; ac.height = H;
  const actx = ac.getContext('2d', { willReadFrequently: true });
  const seek = (t) => new Promise((res) => {
    const h = () => { v.removeEventListener('seeked', h); res(); };
    v.addEventListener('seeked', h);
    v.currentTime = t;
  });
  let prev = null;
  const frameStats = [];
  const total = v.duration || 2;
  for (let t = 0; t < total; t += 0.08) {
    await seek(t);
    actx.drawImage(v, 0, 0, W, H);
    const cur = actx.getImageData(0, 0, W, H);
    if (prev) {
      let cnt = 0;
      for (let i = 0; i < cur.data.length; i += 4) {
        const d = Math.abs(cur.data[i] - prev.data[i]) + Math.abs(cur.data[i + 1] - prev.data[i + 1]) + Math.abs(cur.data[i + 2] - prev.data[i + 2]);
        if (d > 60) cnt++;
      }
      frameStats.push(cnt);
    }
    prev = cur;
  }
  const nonZero = frameStats.filter((x) => x > 5);
  steps.push(`seek samples=${frameStats.length} nonzero=${nonZero.length} max=${Math.max(0, ...frameStats)} avg=${Math.round(frameStats.reduce((a, b) => a + b, 0) / Math.max(1, frameStats.length))}`);
  steps.push(`head=${frameStats.slice(0, 16).join(',')}`);
  return { steps, hasExport: typeof mod.GlMotionDetector };
}, moduleUrl);
console.log(probe.steps.map((s, i) => `${i}: ${s}`).join('\n'));
console.log('GlMotionDetector exported at entry:', probe.hasExport);
writeFileSync('probe-result.json', JSON.stringify(probe, null, 2));
await browser.close();
