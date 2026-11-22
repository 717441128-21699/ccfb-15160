import type {
  AnalysisConfig,
  AnalysisRunSummary,
  Detection,
  FacadeCalibration,
  ThrowEvent,
  Track,
} from './types';
import { GlMotionDetector } from '../gl/detector';
import { MultiTracker } from './tracker';
import { estimateOrigin } from './origin';
import { mergeEvents } from './event-merge';
import { imageToGrid } from './calibration';

export interface ProgressInfo {
  /** 0..1 */
  progress: number;
  currentSec: number;
  durationSec: number;
  processedFrames: number;
  fps: number;
  eventCount: number;
  infrared: boolean;
}

export interface AnalyzerCallbacks {
  onProgress?: (p: ProgressInfo) => void;
  onEvent?: (e: ThrowEvent) => void;
  shouldCancel?: () => boolean;
}

/** 等比缩放，使长边 ≤ maxEdge；maxEdge<=0 时保持原尺寸 */
export function computeAnalysisSize(
  vw: number,
  vh: number,
  maxEdge: number,
): { width: number; height: number } {
  if (maxEdge <= 0) return { width: vw, height: vh };
  const longEdge = Math.max(vw, vh);
  if (longEdge <= maxEdge) return { width: vw, height: vh };
  const s = maxEdge / longEdge;
  return { width: Math.round(vw * s), height: Math.round(vh * s) };
}

/** 基于首帧平均亮度判断红外夜间画面（红外灰度画面亮度低且饱和度极低） */
export function detectInfrared(meanLuma: number, sampleCanvas: HTMLCanvasElement): boolean {
  if (meanLuma > 90) return false;
  const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return meanLuma < 55;
  const w = sampleCanvas.width;
  const h = sampleCanvas.height;
  const data = ctx.getImageData(0, 0, Math.min(64, w), Math.min(64, h)).data;
  let satSum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    satSum += mx === 0 ? 0 : (mx - mn) / mx;
    n++;
  }
  return satSum / n < 0.08;
}

export class VideoAnalyzer {
  private detector: GlMotionDetector;
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: AnalysisConfig;
  private detectionId = 0;
  private frameCursor = 0;
  private events: ThrowEvent[] = [];
  private infrared = false;
  private lastTracker: MultiTracker | null = null;

  constructor(config: AnalysisConfig) {
    this.detector = new GlMotionDetector();
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) throw new Error('无法创建 2D 画布');
    this.ctx = ctx;
    this.config = config;
  }

  /**
   * 分析整个视频文件。
   * fast 模式：快放 + requestVideoFrameCallback，速度快；
   * seek 模式：逐帧定位 currentTime，对损坏/时长异常的录像兼容性好；
   * auto（默认）：先尝试 fast，若首秒没有任何帧回调则自动回退 seek。
   */
  async run(
    file: File,
    calibration: FacadeCalibration,
    callbacks: AnalyzerCallbacks = {},
  ): Promise<{ events: ThrowEvent[]; summary: AnalysisRunSummary }> {
    const cfg = this.config;
    const url = URL.createObjectURL(file);
    const startedAt = performance.now();
    try {
      this.video.src = url;
      await new Promise<void>((resolve, reject) => {
        this.video.onloadedmetadata = () => resolve();
        this.video.onerror = () => reject(new Error('视频解码失败，请确认格式为浏览器支持的 MP4/WebM'));
      });
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      const rawDuration = this.video.duration;
      const duration = isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
      const { width: aw, height: ah } = computeAnalysisSize(vw, vh, cfg.maxAnalysisEdge);
      this.canvas.width = aw;
      this.canvas.height = ah;
      this.detector.resize(aw, ah);
      this.detector.reset();
      this.warmupRemaining = 3;

      const tracker = new MultiTracker({
        maxMissedFrames: cfg.maxMissedFrames,
        maxMatchDistance: cfg.maxMatchDistance,
      });
      this.lastTracker = tracker;

      let processed = 0;
      let skipped = 0;
      let lastProgressT = 0;
      let irDecided = false;
      this.events = [];

      const handleFrame = (timeSec: number, analyze: boolean): void => {
        this.frameCursor++;
        if (!analyze) {
          skipped++;
          return;
        }
        const ev = this.processOneFrame(timeSec, tracker);
        processed++;
        if (!irDecided && processed === 1) {
          this.infrared = this.resolveInfrared(cfg);
          irDecided = true;
        }
        for (const e of ev) {
          const event = this.buildEvent(e, file.name, calibration, timeSec);
          this.events.push(event);
          callbacks.onEvent?.(event);
        }
        const now = performance.now();
        if (now - lastProgressT > 200) {
          lastProgressT = now;
          const elapsed = (now - startedAt) / 1000;
          callbacks.onProgress?.({
            progress: duration ? Math.min(1, timeSec / duration) : 0,
            currentSec: timeSec,
            durationSec: duration,
            processedFrames: processed,
            fps: elapsed > 0 ? processed / elapsed : 0,
            eventCount: this.events.length,
            infrared: this.infrared,
          });
        }
      };

      const useSeek = cfg.frameMode === 'seek' ||
        (cfg.frameMode === 'auto' && duration === 0) ||
        (cfg.frameMode === 'auto' && !(await this.rvfcWorks()));

      // 探测播放可能改变了播放位置，分析前统一归零
      this.video.currentTime = 0;

      if (useSeek) {
        await this.runSeekMode(handleFrame, duration, callbacks);
      } else {
        const ok = await this.runFastMode(handleFrame, callbacks);
        if (!ok && cfg.frameMode === 'auto') {
          // fast 模式中途失效：重置检测状态后回退 seek 重来
          this.detector.reset();
          tracker.reset();
          this.frameCursor = 0;
          this.events = [];
          await this.runSeekMode(handleFrame, duration, callbacks);
        }
      }

      // 收尾：强制闭合所有轨迹
      for (const tr of tracker.activeTracks) tr.closed = true;
      const objects = tracker.finalize(ah, cfg.minTrackDurationSec, cfg.minThrowScore);
      for (const tr of objects) {
        if (this.events.some((e) => e.track.id === tr.id)) continue;
        // 几何校验：轨迹在楼面网格内必须跨越足够多的楼层，否则视为楼面内漂移噪声
        if (!this.spansEnoughFloors(tr, calibration, ah, aw)) continue;
        const event = this.buildEvent(tr, file.name, calibration, this.video.currentTime);
        this.events.push(event);
        callbacks.onEvent?.(event);
      }

      // 合并同一物理轨迹碎裂产生的重复事件
      this.events = mergeEvents(this.events);

      const finalDuration = duration || this.video.currentTime || 0;
      const wallTimeMs = performance.now() - startedAt;
      const summary: AnalysisRunSummary = {
        videoName: file.name,
        durationSec: finalDuration,
        processedFrames: processed,
        skippedFrames: skipped,
        analysisWidth: aw,
        analysisHeight: ah,
        infrared: this.infrared,
        wallTimeMs,
        eventCount: this.events.length,
        trackCount: tracker.getAll().length,
      };
      return { events: [...this.events], summary };
    } finally {
      URL.revokeObjectURL(url);
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
  }

  /** 探测当前浏览器/视频是否支持 requestVideoFrameCallback */
  private async rvfcWorks(): Promise<boolean> {
    if (typeof this.video.requestVideoFrameCallback !== 'function') return false;
    return new Promise((resolve) => {
      let got = false;
      const timer = window.setTimeout(() => {
        if (!got) resolve(false);
      }, 1500);
      this.video.muted = true;
      this.video.playbackRate = 16;
      this.video.play().then(() => {
        this.video.requestVideoFrameCallback(() => {
          got = true;
          window.clearTimeout(timer);
          this.video.pause();
          resolve(true);
        });
      }).catch(() => {
        window.clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /** 快放模式。返回 false 表示中途失效需要回退 */
  private async runFastMode(
    handleFrame: (timeSec: number, analyze: boolean) => void,
    callbacks: AnalyzerCallbacks,
  ): Promise<boolean> {
    await this.video.play();
    this.video.playbackRate = 16;
    const stride = Math.max(1, this.config.frameStride);
    return new Promise<boolean>((resolve, reject) => {
      let cancelled = false;
      let lastFrameAt = performance.now();
      let frameCount = 0;
      let checkStartAt = performance.now();
      let checkStartMedia = 0;
      const watchdog = window.setInterval(() => {
        if (this.video.ended) return;
        const now = performance.now();
        // 1) 完全卡死：3 秒无新帧
        if (now - lastFrameAt > 3000) {
          window.clearInterval(watchdog);
          this.video.pause();
          resolve(false);
          return;
        }
        // 2) 吞吐量自检：每 2 秒比较视频时间推进与墙钟。
        //    playbackRate=16 时正常应推进约 32s 视频/2s 墙钟；
        //    若 rVFC 严重丢帧导致推进 <4s（不足正常的 1/8），回退 seek。
        if (now - checkStartAt >= 2000) {
          const mediaAdvanced = this.video.currentTime - checkStartMedia;
          if (frameCount > 0 && mediaAdvanced < 4) {
            window.clearInterval(watchdog);
            this.video.pause();
            resolve(false);
            return;
          }
          checkStartAt = now;
          checkStartMedia = this.video.currentTime;
        }
      }, 500);
      const finish = (ok: boolean) => {
        window.clearInterval(watchdog);
        resolve(ok);
      };
      const onFrame = (_now: number, metadata?: { mediaTime: number }) => {
        if (cancelled) return;
        if (callbacks.shouldCancel?.()) {
          cancelled = true;
          this.video.pause();
          finish(true);
          return;
        }
        if (this.video.ended || this.video.paused) {
          finish(true);
          return;
        }
        lastFrameAt = performance.now();
        frameCount++;
        const timeSec = metadata?.mediaTime ?? this.video.currentTime;
        const nextCursor = this.frameCursor + 1;
        handleFrame(timeSec, nextCursor % stride === 0);
        this.video.requestVideoFrameCallback(onFrame);
      };
      this.video.onended = () => finish(true);
      this.video.onerror = () => {
        window.clearInterval(watchdog);
        reject(new Error('播放过程中解码出错'));
      };
      this.video.requestVideoFrameCallback(onFrame);
    });
  }

  /** 逐帧 seek 模式：按固定时间步长跳转，每跳稳一帧再分析（步长已含 stride，全部分析） */
  private async runSeekMode(
    handleFrame: (timeSec: number, analyze: boolean) => void,
    duration: number,
    callbacks: AnalyzerCallbacks,
  ): Promise<void> {
    const v = this.video;
    const total = duration > 0 ? duration : await this.probeDuration();
    // 时间步长：按 25fps × frameStride 估算，保证与 fast 模式采样密度一致
    const step = Math.max(0.04, (1 / 25) * Math.max(1, this.config.frameStride));
    v.playbackRate = 1;
    let t = 0;
    this.frameCursor = 0;
    while (t <= total + 1e-6) {
      if (callbacks.shouldCancel?.()) break;
      await this.safeSeek(t);
      handleFrame(t, true);
      t += step;
    }
  }

  /** 带超时与重试的 seek，避免个别录像 blob 索引异常导致永久等待 */
  private async safeSeek(t: number): Promise<void> {
    const v = this.video;
    for (let attempt = 0; attempt < 2; attempt++) {
      let settled = false;
      await new Promise<void>((resolve) => {
        const onSeeked = (): void => {
          settled = true;
          v.removeEventListener('seeked', onSeeked);
          resolve();
        };
        v.addEventListener('seeked', onSeeked);
        const timer = window.setTimeout(() => {
          if (!settled) {
            v.removeEventListener('seeked', onSeeked);
            resolve(); // 超时也放行，用当前画面兜底
          }
        }, 2500);
        v.addEventListener('seeked', () => window.clearTimeout(timer), { once: true });
        try {
          v.currentTime = t;
        } catch {
          window.clearTimeout(timer);
          v.removeEventListener('seeked', onSeeked);
          resolve();
        }
      });
      if (Math.abs(v.currentTime - t) < 0.3 || attempt === 1) return;
    }
  }

  /** duration 不可用时，二分探测视频实际时长 */
  private async probeDuration(): Promise<number> {
    const v = this.video;
    let hi = 60;
    // 指数扩张上界
    for (let i = 0; i < 12; i++) {
      v.currentTime = hi;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      if (Math.abs(v.currentTime - hi) > 0.5) break;
      hi *= 2;
    }
    let lo = 0;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      v.currentTime = mid;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      if (Math.abs(v.currentTime - mid) < 0.5) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  private resolveInfrared(cfg: AnalysisConfig): boolean {
    if (cfg.nightMode === 'night') return true;
    if (cfg.nightMode === 'day') return false;
    return detectInfrared(this.lastMeanLuma, this.canvas);
  }

  private lastMeanLuma = 0;
  private warmupRemaining = 3;

  private processOneFrame(timeSec: number, tracker: MultiTracker): Track[] {
    const cfg = this.config;
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    const result = this.detector.processFrame(this.canvas, {
      learnRate: cfg.backgroundLearnRate,
      threshold: this.infrared ? Math.max(18, cfg.threshold - 8) : cfg.threshold,
      erode: true,
      dilate: true,
      dilatePasses: 2,
    });
    this.lastMeanLuma = result.meanLuma;

    // 冷启动：前 3 个分析帧只让背景模型收敛，不产生检测（避免开头事件被背景吸收/误检）
    if (this.warmupRemaining > 0) {
      this.warmupRemaining--;
      return [];
    }

    const maxArea = this.canvas.width * this.canvas.height * cfg.maxBlobRatio;
    const detections: Detection[] = [];
    const metrics = new Map<number, { area: number; aspect: number }>();
    for (const b of result.blobs) {
      if (b.area < cfg.minBlobArea || b.area > maxArea) continue;
      const id = ++this.detectionId;
      const W = this.canvas.width;
      const H = this.canvas.height;
      detections.push({
        id,
        frame: this.frameCursor,
        timeSec,
        cx: b.cx / W,
        cy: b.cy / H,
        x: b.x / W,
        y: b.y / H,
        w: b.w / W,
        h: b.h / H,
        area: b.area,
        fillRatio: b.fillRatio,
        meanLuma: b.meanLuma,
      });
      metrics.set(id, { area: b.area, aspect: b.w / Math.max(1, b.h) });
    }
    tracker.update(detections, metrics, { width: this.canvas.width, height: this.canvas.height });

    // 实时闭合判定：对刚闭合且合格的轨迹立刻出事件
    const ready: Track[] = [];
    for (const tr of tracker.getAll()) {
      if (!tr.closed || tr.finalized) continue;
      tracker.classifyOne(tr, this.canvas.height);
      if (
        tr.kind === 'object' &&
        tr.features.durationSec >= cfg.minTrackDurationSec &&
        tr.score >= cfg.minThrowScore &&
        !this.events.some((e) => e.track.id === tr.id)
      ) {
        ready.push(tr);
      }
    }
    return ready;
  }

  /**
   * 几何校验：
   * 1. 轨迹多数点必须落在楼面标定区域内（高空抛物在楼面前，楼外飞鸟/边缘噪声排除）；
   * 2. 首尾在网格竖直方向跨越 ≥3 层（真实坠落跨多层，楼面内短漂移排除）。
   */
  private spansEnoughFloors(
    track: Track,
    calibration: FacadeCalibration,
    ah: number,
    aw: number,
  ): boolean {
    const pts = track.points;
    if (pts.length < 2) return false;
    let inside = 0;
    for (const p of pts) {
      const g = imageToGrid(calibration, { x: p.x / aw, y: p.y / ah });
      if (g.u >= -0.5 && g.u <= calibration.units + 0.5 && g.v >= -0.5 && g.v <= calibration.floors + 0.5) {
        inside++;
      }
    }
    if (inside / pts.length < 0.7) return false;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const gFirst = imageToGrid(calibration, { x: first.x / aw, y: first.y / ah });
    const gLast = imageToGrid(calibration, { x: last.x / aw, y: last.y / ah });
    const floorSpan = Math.abs(gFirst.v - gLast.v);
    return floorSpan >= 3;
  }

  private buildEvent(
    track: Track,
    videoName: string,
    calibration: FacadeCalibration,
    endSec: number,
  ): ThrowEvent {
    const origin = estimateOrigin(track, calibration, {
      analysisWidth: this.canvas.width,
      analysisHeight: this.canvas.height,
      windCompensation: this.config.windCompensation,
    });
    const first = track.points[0];
    const last = track.points[track.points.length - 1];
    const thumbnails = this.captureThumbnails(track);
    return {
      id: `evt_${Date.now().toString(36)}_${track.id}`,
      calibrationId: calibration.id,
      videoName,
      startSec: first.timeSec,
      endSec: Math.max(endSec, last.timeSec),
      startFrame: first.frame,
      endFrame: last.frame,
      track,
      origin,
      infrared: this.infrared,
      thumbnails,
      createdAt: Date.now(),
    };
  }

  /** 抽轨迹首/中/尾三帧缩略图（小尺寸 dataURL，事件列表与报告用） */
  private captureThumbnails(track: Track): string[] {
    // 分析阶段视频处于快放状态，无法逐帧 seek 截图；
    // 这里用当前分析画布绘制轨迹点快照，事件复核时再由报告页按需 seek 原视频。
    const out: string[] = [];
    const picks = [0, Math.floor(track.points.length / 2), track.points.length - 1];
    const W = 160;
    const H = Math.round((this.canvas.height / this.canvas.width) * W);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const cx = c.getContext('2d');
    if (!cx) return out;
    for (const idx of new Set(picks)) {
      const p = track.points[idx];
      cx.drawImage(this.canvas, 0, 0, W, H);
      cx.strokeStyle = '#ff4d4f';
      cx.lineWidth = 2;
      cx.beginPath();
      cx.arc(p.x / this.canvas.width * W, p.y / this.canvas.height * H, 5, 0, Math.PI * 2);
      cx.stroke();
      out.push(c.toDataURL('image/jpeg', 0.7));
    }
    return out;
  }

  get isInfrared(): boolean {
    return this.infrared;
  }

  get analysisSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  /** 当前分析画布（供 UI 实时预览） */
  get analysisCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /** 调试：返回最近一次运行的全部轨迹特征（排查漏检/误报） */
  getTrackDiagnostics(frameHeight: number): Array<{
    id: number; kind: string; score: number; points: number;
    durationSec: number; drop: number; dropRatio: number; accelY: number;
    straightness: number; downwardRatio: number; areaCv: number; meanArea: number;
  }> {
    if (!this.lastTracker) return [];
    return this.lastTracker.getAll().map((tr) => {
      this.lastTracker!.classifyOne(tr, frameHeight);
      const f = tr.features;
      return {
        id: tr.id, kind: tr.kind, score: tr.score, points: f.pointCount,
        durationSec: f.durationSec, drop: f.verticalDrop, dropRatio: f.verticalDrop / frameHeight,
        accelY: f.accelY, straightness: f.straightness, downwardRatio: f.downwardRatio,
        areaCv: f.areaCv, meanArea: f.meanArea,
      };
    });
  }

  dispose(): void {
    this.detector.dispose();
  }
}
