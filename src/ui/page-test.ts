import type { FacadeCalibration, AnalysisConfig } from '../core/types';
import { DEFAULT_ANALYSIS_CONFIG } from '../core/types';
import { createCalibration } from '../core/calibration';
import {
  generateSyntheticVideo,
  Rng,
  type SyntheticObjectKind,
  type SyntheticVideoConfig,
} from '../core/synthetic';
import { VideoAnalyzer } from '../core/analyzer';
import { evaluate, type EvaluationReport } from '../core/evaluation';
import { calibrationStore, eventStore } from '../core/storage';
import { el, toast, fmtTime } from './app-state';

interface ScenarioPreset {
  name: string;
  windLevel: number;
  infrared: boolean;
  interferers: SyntheticVideoConfig['interferers'];
  throwCount: number;
  durationSec: number;
}

const PRESETS: ScenarioPreset[] = [
  { name: '晴天无风 · 多物体', windLevel: 0, infrared: false, interferers: [{ kind: 'bird', count: 2 }], throwCount: 8, durationSec: 40 },
  { name: '微风 · 树叶干扰', windLevel: 1, infrared: false, interferers: [{ kind: 'leaf', count: 14 }, { kind: 'bird', count: 2 }], throwCount: 8, durationSec: 40 },
  { name: '大风 · 树叶+飞鸟', windLevel: 3, infrared: false, interferers: [{ kind: 'leaf', count: 22 }, { kind: 'bird', count: 4 }], throwCount: 10, durationSec: 45 },
  { name: '雨夜红外 · 雨滴干扰', windLevel: 2, infrared: true, interferers: [{ kind: 'rain', count: 30 }, { kind: 'leaf', count: 8 }], throwCount: 8, durationSec: 40 },
];

const OBJECT_KINDS: SyntheticObjectKind[] = ['bottle', 'apple', 'bag', 'brick', 'phone'];
const OBJECT_LABEL: Record<SyntheticObjectKind, string> = {
  bottle: '塑料瓶', apple: '水果', bag: '垃圾袋', brick: '砖块', phone: '手机',
};

export function renderTestPage(): HTMLElement {
  const root = el('div');
  root.append(
    el('h1', { class: 'page-title' }, '合成测试与指标验收'),
    el('p', { class: 'page-desc' },
      '按物体类型与风速合成带真值标注的测试视频（树叶/飞鸟/雨滴干扰、红外夜间画面），自动跑完整分析链路并核验两项验收指标：楼层误差 ≤ 1 层、户号判对率 ≥ 90%。'),
  );

  const presetSelect = el('select', {}) as HTMLSelectElement;
  PRESETS.forEach((p, i) => presetSelect.append(el('option', { value: String(i) }, p.name)));
  const seedInput = el('input', { type: 'number', value: '20261122', min: '1' }) as HTMLInputElement;
  const durationInput = el('input', { type: 'number', value: '40', min: '10', max: '300', step: '5' }) as HTMLInputElement;
  const throwsInput = el('input', { type: 'number', value: '8', min: '1', max: '30' }) as HTMLInputElement;
  const keepVideo = el('input', { type: 'checkbox' }) as HTMLInputElement;
  keepVideo.checked = true;

  const runBtn = el('button', { class: 'btn', type: 'button' }, '生成视频并自动验收');
  const progressBar = el('div', { class: 'progress-bar', style: 'width:0%' });
  const statusLine = el('div', { class: 'muted', style: 'margin-top:8px' }, '等待运行');
  const resultHost = el('div');
  let lastVideoUrl: string | null = null;
  let lastExt = 'mp4';

  function setProgress(pct: number, text: string): void {
    progressBar.style.width = `${pct}%`;
    statusLine.textContent = text;
  }

  async function run(): Promise<void> {
    runBtn.disabled = true;
    resultHost.innerHTML = '';
    try {
      const preset = PRESETS[parseInt(presetSelect.value, 10)];
      const duration = parseInt(durationInput.value, 10);
      const throwCount = parseInt(throwsInput.value, 10);
      const seed = parseInt(seedInput.value, 10) || 1;
      const rng = new Rng(seed);

      // 固定机位标定并保存（测试页的标准机位）
      const cal: FacadeCalibration = createCalibration({
        videoWidth: 960,
        videoHeight: 540,
        floors: 18,
        units: 4,
        name: '合成测试机位',
        infrared: preset.infrared,
      });
      calibrationStore.save(cal);

      // 生成抛物真值：楼层 6..17，户号 0..3，时间均匀分布
      const throws = Array.from({ length: throwCount }, (_, i) => ({
        kind: OBJECT_KINDS[i % OBJECT_KINDS.length],
        floorIndex: rng.int(6, cal.floors - 1),
        unitIndex: rng.int(0, cal.units - 1),
        vx: rng.range(-0.4, 0.4),
        vy: rng.range(-0.2, 0.6),
        startSec: 3 + (i * (duration - 8)) / Math.max(1, throwCount) + rng.range(0, 1.2),
      }));

      const cfg: SyntheticVideoConfig = {
        width: 960,
        height: 540,
        fps: 25,
        durationSec: duration,
        calibration: cal,
        windLevel: preset.windLevel,
        throws,
        interferers: preset.interferers.map((x) => ({ ...x })),
        infrared: preset.infrared,
        seed,
      };

      setProgress(5, '正在合成测试视频…');
      const synth = await generateSyntheticVideo(cfg, (p) => setProgress(5 + p * 35, `合成视频中 ${(p * 100).toFixed(0)}%`));
      const file = new File([synth.blob], `synthetic_${preset.name}.${synth.extension}`, { type: synth.mimeType });
      lastExt = synth.extension;
      if (lastVideoUrl) URL.revokeObjectURL(lastVideoUrl);
      lastVideoUrl = URL.createObjectURL(synth.blob);

      setProgress(42, '视频合成完成，开始 WebGL2 分析（seek 逐帧模式，结果可复现）…');
      // 指标验收用 seek 模式：逐帧定位、不依赖 rVFC，无头/真实环境结果一致可复现。
      // frameStride=3：约 8.3fps 采样，兼顾速度与轨迹连续性。
      const analysisCfg: AnalysisConfig = {
        ...DEFAULT_ANALYSIS_CONFIG,
        maxAnalysisEdge: 720,
        frameStride: 3,
        frameMode: 'seek',
      };
      if (preset.infrared) analysisCfg.nightMode = 'night';
      const analyzer = new VideoAnalyzer(analysisCfg);
      const { events, summary } = await analyzer.run(file, cal, {
        onProgress: (p) => setProgress(42 + p.progress * 53, `分析中 ${(p.progress * 100).toFixed(0)}% · 已检出 ${p.eventCount} 起`),
      });
      analyzer.dispose();

      // 持久化事件，使事件列表/取证报告页可查看（缩略图占空间，失败时降级）
      for (const e of events) eventStore.save(e);

      setProgress(97, '比对真值、计算指标…');
      const report = evaluate(events, synth.groundTruth);
      setProgress(100, `完成：素材 ${fmtTime(duration)}，分析用时 ${(summary.wallTimeMs / 1000).toFixed(1)} 秒`);
      renderResult(report, summary, lastVideoUrl, lastExt);
      toast('验收测试完成', 'ok');
    } catch (err) {
      console.error(err);
      toast(`测试失败：${(err as Error).message}`, 'error');
      statusLine.textContent = '测试失败';
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', run);

  function renderResult(
    report: EvaluationReport,
    summary: { wallTimeMs: number; durationSec: number; processedFrames: number; trackCount: number },
    videoUrl: string,
    ext: string,
  ): void {
    const speed = summary.durationSec / Math.max(0.001, summary.wallTimeMs / 1000);

    const metricCard = el('div', { class: 'grid-3' },
      metric('楼层误差 ≤1 层占比', `${(report.floorWithinOneRate * 100).toFixed(1)}%`,
        report.passFloor, `平均绝对误差 ${isFinite(report.meanFloorError) ? report.meanFloorError.toFixed(2) : '-'} 层`),
      metric('户号判对率', `${(report.unitAccuracy * 100).toFixed(1)}%`,
        report.passUnit, `目标 ≥ 90%，匹配 ${report.matchedCount}/${report.truthCount}`),
      metric('分析速度', `${speed.toFixed(1)}× 实时`,
        speed >= 12, `${fmtTime(summary.durationSec)} 素材用时 ${(summary.wallTimeMs / 1000).toFixed(1)}s（1h 预算 ≤300s）`),
    );

    const recallCard = el('div', { class: 'grid-3', style: 'margin-top:14px' },
      miniStat('真值事件', String(report.truthCount)),
      miniStat('检出事件', String(report.detectedCount)),
      miniStat('误报数量', String(report.falsePositives.length), report.falsePositives.length > 0 ? 'warn' : 'ok'),
    );

    // 明细表
    const rows = report.rows.map((r) =>
      el('tr', {},
        el('td', { class: 'mono' }, fmtTime(r.truth.startSec)),
        el('td', {}, `${r.truth.floorLabel} / ${r.truth.unitLabel}户`),
        el('td', {}, OBJECT_LABEL[r.truth.kind]),
        el('td', {}, r.matched
          ? `${r.matched.origin.cell.floorLabel} / ${r.matched.origin.cell.unitLabel}户`
          : el('span', { class: 'tag danger' }, '漏检')),
        el('td', {}, r.floorError === undefined
          ? '-'
          : el('span', { class: r.floorError <= 1 ? 'tag ok' : 'tag danger' }, `${r.floorError} 层`)),
        el('td', {}, r.unitCorrect === undefined
          ? '-'
          : r.unitCorrect ? el('span', { class: 'tag ok' }, '正确') : el('span', { class: 'tag danger' }, '错误')),
      ),
    );
    const table = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, '时间'), el('th', {}, '真值(层/户)'), el('th', {}, '物体'),
        el('th', {}, '检测(层/户)'), el('th', {}, '楼层误差'), el('th', {}, '户号'),
      )),
      el('tbody', {}, ...rows),
    );

    const video = el('video', { controls: '', src: videoUrl, style: 'width:100%;border-radius:8px' }) as HTMLVideoElement;
    const downloadBtn = el('a', {
      class: 'btn secondary',
      href: videoUrl,
      download: `synthetic_test.${ext}`,
      style: 'text-decoration:none;display:inline-block;margin-top:8px',
    }, keepVideo.checked ? '下载合成视频' : '');
    if (!keepVideo.checked) downloadBtn.style.display = 'none';

    const passAll = report.passFloor && report.passUnit;
    resultHost.append(
      el('div', { class: 'card', style: `border-left:5px solid ${passAll ? 'var(--ok)' : 'var(--danger)'}` },
        el('h3', {}, passAll ? '✓ 验收指标通过' : '✗ 验收指标未全部达标，可调整分析参数后复测'),
        metricCard, recallCard,
        el('div', { class: 'muted', style: 'margin-top:10px;font-size:12px' },
          `召回率 ${(report.recall * 100).toFixed(1)}% · 精确率 ${(report.precision * 100).toFixed(1)}% · 跟踪轨迹总数 ${summary.trackCount} · 处理帧 ${summary.processedFrames}`),
      ),
      el('div', { class: 'card' }, el('h3', {}, '逐事件比对（真值 vs 检测）'), table),
      el('div', { class: 'card' }, el('h3', {}, '合成视频回放'), video, downloadBtn),
    );
  }

  root.append(
    el('div', { class: 'card' },
      el('h3', {}, '测试场景'),
      el('div', { class: 'grid-2' },
        el('label', { class: 'field' }, el('b', {}, '预设场景（物体/风速/干扰）'), presetSelect),
        el('label', { class: 'field' }, el('b', {}, '随机种子（可复现）'), seedInput),
      ),
      el('div', { class: 'grid-3', style: 'margin-top:10px' },
        el('label', { class: 'field' }, el('b', {}, '时长(秒)'), durationInput),
        el('label', { class: 'field' }, el('b', {}, '抛物事件数'), throwsInput),
        el('label', { class: 'field' }, el('b', {}, '保留视频供下载'), keepVideo),
      ),
      el('div', { class: 'row', style: 'margin-top:14px' }, runBtn),
      el('div', { style: 'margin-top:14px' }, el('div', { class: 'progress-wrap' }, progressBar), statusLine),
    ),
    resultHost,
  );
  return root;
}

function metric(label: string, value: string, pass: boolean, hint: string): HTMLElement {
  return el('div', { class: 'stat', style: `border-left:4px solid ${pass ? 'var(--ok)' : 'var(--danger)'}` },
    el('div', { class: 'lbl' }, label),
    el('div', { style: 'font-size:26px;font-weight:700;color:var(--fg);margin:2px 0' },
      value, ' ',
      el('span', { class: `tag ${pass ? 'ok' : 'danger'}`, style: 'font-size:11px' }, pass ? '达标' : '未达标'),
    ),
    el('div', { class: 'muted', style: 'font-size:12px' }, hint),
  );
}

function miniStat(label: string, value: string, tone: 'ok' | 'warn' | 'plain' = 'plain'): HTMLElement {
  return el('div', { class: 'stat' },
    el('div', { class: 'num', style: tone === 'warn' ? 'color:var(--warn)' : tone === 'ok' ? 'color:var(--ok)' : '' }, value),
    el('div', { class: 'lbl' }, label),
  );
}
