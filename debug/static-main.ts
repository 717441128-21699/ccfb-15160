import { GlMotionDetector } from '../src/gl/detector';

const logEl = document.getElementById('log')!;
const out: string[] = [];
const emit = (s: string): void => { out.push(s); logEl.textContent = out.join('\n'); };

/**
 * 静态背景探针：录制一段无任何运动物体的纯静态楼体视频，
 * seek 逐帧回放并跑真实 GL 检测器，统计假运动 blob。
 */
async function runStaticProbe(): Promise<void> {
  const W = 480;
  const H = 270;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // 画一个带窗户的静态楼体；jitter 模拟真实传感器的轻微亮度抖动（确保编码器产生帧）
  const drawStatic = (jitter: number): void => {
    ctx.fillStyle = '#9fc5e8';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#c9c2b4';
    ctx.fillRect(60, 20, 360, 230);
    for (let f = 0; f < 10; f++) {
      for (let u = 0; u < 4; u++) {
        ctx.fillStyle = (f + u) % 3 === 0 ? '#f5e6b8' : '#7d8fa3';
        ctx.fillRect(75 + u * 85, 30 + f * 22, 55, 14);
      }
    }
    if (jitter > 0) {
      ctx.fillStyle = `rgba(255,255,255,${jitter})`;
      ctx.fillRect(0, 0, W, H);
    }
  };

  const mime = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'].find((m) =>
    MediaRecorder.isTypeSupported(m),
  )!;
  emit('mime=' + mime);
  const stream = canvas.captureStream(25);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onerror = (e) => emit('recorder error: ' + (e as Event).type);
  rec.onwarning = (e) => emit('recorder warning: ' + (e as Event).type);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  rec.start();
  emit('recording state=' + rec.state + ' track=' + track.readyState + ' requestFrame=' + typeof track.requestFrame);
  for (let f = 0; f < 40; f++) {
    drawStatic(0);
    // 一个只在顶部 10px 内轻微移动的小点（保证编码器出帧，但不构成跨楼层下落）
    ctx.fillStyle = '#ff5252';
    ctx.beginPath();
    ctx.arc(400, 30 + (f % 6), 3, 0, Math.PI * 2);
    ctx.fill();
    track.requestFrame?.();
    await new Promise((r) => {
      const begin = performance.now();
      const spin = () => (performance.now() - begin >= 38 ? r() : requestAnimationFrame(spin));
      requestAnimationFrame(spin);
    });
  }
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: mime });
  emit('recorded blob=' + blob.size);

  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.src = URL.createObjectURL(blob);
  await new Promise((r) => (v.onloadedmetadata = r));
  emit('metadata duration=' + v.duration);

  const ac = document.createElement('canvas');
  ac.width = W;
  ac.height = H;
  const actx = ac.getContext('2d')!;
  const detector = new GlMotionDetector();
  detector.resize(W, H);

  const seek = (t: number): Promise<void> =>
    new Promise((res) => {
      let done = false;
      const h = (): void => { if (done) return; done = true; v.removeEventListener('seeked', h); window.clearTimeout(timer); res(); };
      const timer = window.setTimeout(h, 2000);
      v.addEventListener('seeked', h);
      v.currentTime = t;
    });

  const lines: string[] = [];
  let totalBlobs = 0;
  const total = v.duration || 1.6;
  for (let t = 0; t < total; t += 0.08) {
    await seek(t);
    actx.drawImage(v, 0, 0, W, H);
    const r = detector.processFrame(ac, { learnRate: 0.06, threshold: 28 / 255, erode: true, dilate: true, dilatePasses: 2 });
    const valid = r.blobs.filter((b) => b.area >= 6);
    if (valid.length) {
      totalBlobs += valid.length;
      lines.push(`t=${t.toFixed(2)} blobs=${valid.length} ` + valid.map((b) => `a=${b.area}@(${b.cx.toFixed(0)},${b.cy.toFixed(0)})`).join(' '));
    }
  }
  emit(`静态视频 seek 分析：总假 blob=${totalBlobs}，duration=${v.duration.toFixed(2)}`);
  for (const ln of lines.slice(0, 25)) emit(ln);
  detector.dispose();
  (window as unknown as { __STATIC_DONE: boolean }).__STATIC_DONE = true;
  emit('DONE');
}

runStaticProbe().catch((e) => {
  emit('ERROR: ' + (e as Error).message);
  (window as unknown as { __STATIC_DONE: boolean }).__STATIC_DONE = true;
});

