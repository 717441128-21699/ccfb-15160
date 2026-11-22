/**
 * 诊断：无头 Edge 中 MediaRecorder 录制视频的回放行为
 * （duration、requestVideoFrameCallback、ended、playbackRate）
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const EDGE = existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext()).newPage();
page.on('console', (m) => console.log('[browser]', m.text()));
await page.goto('http://localhost:5317/', { waitUntil: 'networkidle' });

const result = await page.evaluate(async () => {
  const out = {};
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  const ctx = c.getContext('2d');
  const mime = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  out.mime = mime;
  out.rVFC = typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';

  const rec = new MediaRecorder(c.captureStream(25), { mimeType: mime, videoBitsPerSecond: 2_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start(200);
  for (let f = 0; f < 50; f++) {
    ctx.fillStyle = f % 2 ? '#123' : '#321';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(f), 10, 20);
    await new Promise((r) => setTimeout(r, 40));
  }
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: mime });
  out.blobSize = blob.size;

  const v = document.createElement('video');
  v.muted = true; v.playsInline = true;
  v.src = URL.createObjectURL(blob);
  const meta = new Promise((r) => (v.onloadedmetadata = r));
  await meta;
  out.durationRaw = v.duration;
  out.videoWidth = v.videoWidth;

  let rvfCount = 0;
  const rvfDone = new Promise((r) => {
    const onFrame = () => {
      rvfCount++;
      if (rvfCount >= 5 || v.ended) return r();
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  });
  const ended = new Promise((r) => (v.onended = r));
  v.playbackRate = 16;
  await v.play();
  await Promise.race([rvfDone, new Promise((r) => setTimeout(r, 4000))]);
  out.rvfCountAfter4s = rvfCount;
  await Promise.race([ended, new Promise((r) => setTimeout(r, 6000))]);
  out.ended = v.ended;
  out.currentTime = v.currentTime;
  out.paused = v.paused;
  return out;
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
