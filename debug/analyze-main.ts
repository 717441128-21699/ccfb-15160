import { VideoAnalyzer } from '../src/core/analyzer';
import { generateSyntheticVideo, type SyntheticVideoConfig } from '../src/core/synthetic';
import { createCalibration } from '../src/core/calibration';
import { DEFAULT_ANALYSIS_CONFIG, type AnalysisConfig } from '../src/core/types';

const logEl = document.getElementById('log')!;
const lines: string[] = [];
const log = (s: string): void => {
  lines.push(s);
  logEl.textContent = lines.join('\n');
};

const mode = (new URLSearchParams(location.search).get('mode') as AnalysisConfig['frameMode']) ?? 'seek';
log(`抽帧模式: ${mode}`);

const cal = createCalibration({ videoWidth: 960, videoHeight: 540, floors: 18, units: 4, name: '调试机位' });
const cfg: SyntheticVideoConfig = {
  width: 960,
  height: 540,
  fps: 25,
  durationSec: 12,
  calibration: cal,
  windLevel: 1,
  throws: [
    { kind: 'bottle', floorIndex: 14, unitIndex: 2, vx: 0.1, vy: 0.2, startSec: 3 },
    { kind: 'apple', floorIndex: 10, unitIndex: 1, vx: -0.1, vy: 0.0, startSec: 7 },
  ],
  interferers: [{ kind: 'leaf', count: 6 }, { kind: 'bird', count: 1 }],
  infrared: false,
  seed: 42,
};

try {
  log('开始合成视频…');
  const synth = await generateSyntheticVideo(cfg, (p) => {
    if (Math.round(p * 20) % 5 === 0) log(`合成 ${(p * 100).toFixed(0)}%`);
  });
  log(`合成完成 blob=${synth.blob.size}B mime=${synth.mimeType} 真值=${synth.groundTruth.length} 起`);
  const file = new File([synth.blob], 'debug.' + synth.extension, { type: synth.mimeType });

  const acfg: AnalysisConfig = { ...DEFAULT_ANALYSIS_CONFIG, frameMode: mode, maxAnalysisEdge: 960 };
  const analyzer = new VideoAnalyzer(acfg);
  let lastReported = -1;
  const { events, summary } = await analyzer.run(file, cal, {
    onProgress: (p) => {
      if (p.processedFrames - lastReported >= 20) {
        lastReported = p.processedFrames;
        log(`进度 ${(p.progress * 100).toFixed(0)}% 处理帧=${p.processedFrames} 事件=${p.eventCount} fps=${p.fps.toFixed(1)}`);
      }
    },
  });
  analyzer.dispose();

  log('———— 分析汇总 ————');
  log(`duration=${summary.durationSec.toFixed(2)}s 处理帧=${summary.processedFrames} 跳过=${summary.skippedFrames}`);
  log(`轨迹总数=${summary.trackCount} 事件=${summary.eventCount} 用时=${(summary.wallTimeMs / 1000).toFixed(2)}s`);
  // 输出较长轨迹的特征，定位真值物体为何被漏检
  const diags = analyzer.getTrackDiagnostics(summary.analysisHeight)
    .filter((d) => d.points >= 6)
    .sort((a, b) => b.drop - a.drop)
    .slice(0, 14);
  log('—— 下落距离最大的 14 条轨迹 ——');
  for (const d of diags) {
    log(`#${d.id} ${d.kind} s=${d.score.toFixed(2)} n=${d.points} t=${d.durationSec.toFixed(2)} drop=${d.drop.toFixed(0)}(${(d.dropRatio * 100).toFixed(0)}%) acc=${d.accelY.toFixed(0)} str=${d.straightness.toFixed(2)} down=${d.downwardRatio.toFixed(2)} cv=${d.areaCv.toFixed(2)}`);
  }
  for (const e of events) {
    log(
      `事件: ${e.origin.cell.floorLabel}/${e.origin.cell.unitLabel}户 置信=${(e.origin.confidence * 100).toFixed(0)}% ` +
        `start=${e.startSec.toFixed(2)} 点数=${e.track.points.length} score=${e.track.score.toFixed(2)}`,
    );
  }
  // 反推网格坐标核查
  log('—— 反推抛出点网格坐标 ——');
  for (const e of events) {
    log(`网格点 u=${e.origin.point.x.toFixed(3)},v(图像y)=${e.origin.point.y.toFixed(3)} 出手t=${e.origin.launchTimeSec.toFixed(2)}`);
  }
  log('—— 真值 ——');
  for (const g of synth.groundTruth) {
    log(`真值 ${g.floorLabel}/${g.unitLabel}户 start=${g.startSec.toFixed(2)} kind=${g.kind}`);
  }
  (window as unknown as { __ANALYZE_DONE: boolean }).__ANALYZE_DONE = true;
  log('DONE');
} catch (err) {
  log('ERROR: ' + (err as Error).message);
  (window as unknown as { __ANALYZE_DONE: boolean }).__ANALYZE_DONE = true;
}
