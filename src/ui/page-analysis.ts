import type { AnalysisConfig, ThrowEvent } from '../core/types';
import { DEFAULT_ANALYSIS_CONFIG } from '../core/types';
import { calibrationStore, eventStore } from '../core/storage';
import { VideoAnalyzer } from '../core/analyzer';
import { GlMotionDetector } from '../gl/detector';
import { drawTrackOverlay } from './overlay-draw';
import { el, toast, fmtTime, setState, getState, bump } from './app-state';

export function renderAnalysisPage(): HTMLElement {
  const root = el('div');
  const cfg: AnalysisConfig = { ...DEFAULT_ANALYSIS_CONFIG };
  let analyzer: VideoAnalyzer | null = null;
  let cancelRequested = false;
  let events: ThrowEvent[] = [];
  let currentCalId = getState().calibrationId;

  root.append(
    el('h1', { class: 'page-title' }, '视频分析'),
    el('p', { class: 'page-desc' }, '选择标定与监控视频后开始分析。检测在 WebGL2 上运行（背景建模、差分、形态学），轨迹跟踪与抛物线反推在本地完成，视频不会上传。'),
  );

  if (!GlMotionDetector.isSupported()) {
    root.append(el('div', { class: 'card', style: 'border-color:var(--danger);color:var(--danger)' },
      '当前浏览器不支持 WebGL2，请使用最新版 Edge / Chrome。'));
    return root;
  }

  const calibrations = calibrationStore.list();
  const calSelect = el('select', {}) as HTMLSelectElement;
  for (const c of calibrations) {
    calSelect.append(el('option', { value: c.id }, `${c.name}（${c.floors}层×${c.units}户）`));
  }
  if (currentCalId && calibrations.some((c) => c.id === currentCalId)) {
    calSelect.value = currentCalId;
  }
  calSelect.addEventListener('change', () => {
    currentCalId = calSelect.value;
    setState({ calibrationId: currentCalId });
  });

  // 参数控件
  function numField(label: string, key: keyof AnalysisConfig, step: number, min: number, max: number): HTMLElement {
    const input = el('input', { type: 'number', step: String(step), min: String(min), max: String(max), value: String(cfg[key]) }) as HTMLInputElement;
    input.addEventListener('change', () => {
      (cfg[key] as number) = parseFloat(input.value);
    });
    return el('label', { class: 'field' }, el('b', {}, label), input);
  }
  const learnInput = el('input', {
    type: 'number', step: '0.005', min: '0.002', max: '0.2', value: String(cfg.backgroundLearnRate),
  }) as HTMLInputElement;
  learnInput.addEventListener('change', () => {
    cfg.backgroundLearnRate = parseFloat(learnInput.value);
  });
  const nightSelect = el('select', {}) as HTMLSelectElement;
  for (const [v, t] of [['auto', '自动判断'], ['day', '强制白昼'], ['night', '强制红外夜间']] as const) {
    nightSelect.append(el('option', { value: v }, t));
  }
  nightSelect.addEventListener('change', () => {
    cfg.nightMode = nightSelect.value as AnalysisConfig['nightMode'];
  });
  const windInput = el('input', { type: 'range', min: '0', max: '1', step: '0.1', value: String(cfg.windCompensation) }) as HTMLInputElement;
  const windVal = el('span', { class: 'mono' }, String(cfg.windCompensation));
  windInput.addEventListener('input', () => {
    cfg.windCompensation = parseFloat(windInput.value);
    windVal.textContent = windInput.value;
  });

  const fileLabel = el('span', { class: 'tag gray' }, '未选择视频');
  let selectedFile: File | null = null;
  const pickBtn = el('button', { class: 'btn secondary', type: 'button' }, '选择监控视频');
  const hiddenInput = el('input', { type: 'file', accept: 'video/*', style: 'display:none' }) as HTMLInputElement;
  pickBtn.append(hiddenInput);
  pickBtn.addEventListener('click', () => hiddenInput.click());
  hiddenInput.addEventListener('change', () => {
    selectedFile = hiddenInput.files?.[0] ?? null;
    fileLabel.textContent = selectedFile ? selectedFile.name : '未选择视频';
    fileLabel.className = selectedFile ? 'tag info' : 'tag gray';
  });

  const startBtn = el('button', { class: 'btn', type: 'button' }, '开始分析');
  const cancelBtn = el('button', { class: 'btn danger', type: 'button', disabled: true }, '停止');

  // 进度区
  const progressBar = el('div', { class: 'progress-bar', style: 'width:0%' });
  const progressWrap = el('div', { class: 'progress-wrap' }, progressBar);
  const statusLine = el('div', { class: 'muted', style: 'margin-top:8px' }, '等待开始');
  const statFps = statBox('处理帧率', '-');
  const statEvents = statBox('检出事件', '0');
  const statTracks = statBox('活动轨迹', '-');
  const statIr = statBox('画面模式', '-');

  // 实时画面
  const stage = el('div', { class: 'video-stage' });
  const liveCanvas = el('canvas', {}) as HTMLCanvasElement;
  const overlayCanvas = el('canvas', { class: 'overlay-canvas' }) as HTMLCanvasElement;
  stage.append(liveCanvas, overlayCanvas);
  stage.style.display = 'none';

  // 事件实时列表
  const eventFeed = el('div');

  function statBox(label: string, value: string): { box: HTMLElement; set: (v: string) => void } {
    const num = el('div', { class: 'num' }, value);
    const box = el('div', { class: 'stat' }, num, el('div', { class: 'lbl' }, label));
    return { box, set: (v) => (num.textContent = v) };
  }

  function addEventCard(ev: ThrowEvent): void {
    const cal = calibrationStore.get(ev.calibrationId);
    const card = el('div', {
      class: 'card',
      style: 'padding:12px;cursor:pointer;border-left:4px solid var(--danger)',
      onclick: () => {
        setState({ page: 'events', selectedEventId: ev.id });
      },
    },
      el('div', { class: 'row', style: 'justify-content:space-between' },
        el('b', {}, `${ev.origin.cell.floorLabel} · ${ev.origin.cell.unitLabel}户`),
        el('span', { class: 'tag danger' }, `置信度 ${(ev.origin.confidence * 100).toFixed(0)}%`),
      ),
      el('div', { class: 'muted', style: 'margin-top:4px;font-size:12px' },
        `${fmtTime(ev.startSec)} 起 · ${ev.videoName}${ev.infrared ? ' · 红外' : ''}${cal ? '' : ' · 标定已删除'}`),
    );
    eventFeed.prepend(card);
  }

  startBtn.addEventListener('click', async () => {
    if (!selectedFile) {
      toast('请先选择监控视频', 'error');
      return;
    }
    const cal = calibrationStore.get(calSelect.value);
    if (!cal) {
      toast('请先在「楼栋标定」页保存一个标定', 'error');
      return;
    }
    events = [];
    eventFeed.innerHTML = '';
    cancelRequested = false;
    startBtn.disabled = true;
    cancelBtn.disabled = false;
    stage.style.display = 'block';
    analyzer = new VideoAnalyzer(cfg);

    try {
      const { summary } = await analyzer.run(selectedFile, cal, {
        shouldCancel: () => cancelRequested,
        onProgress: (p) => {
          progressBar.style.width = `${(p.progress * 100).toFixed(1)}%`;
          statusLine.textContent = `${fmtTime(p.currentSec)} / ${fmtTime(p.durationSec)}（${(p.progress * 100).toFixed(1)}%）`;
          statFps.set(`${p.fps.toFixed(1)} fps`);
          statEvents.set(String(p.eventCount));
          statIr.set(p.infrared ? '红外夜间' : '白昼');
        },
        onEvent: (ev) => {
          events.push(ev);
          eventStore.save(ev);
          statEvents.set(String(events.length));
          addEventCard(ev);
          // 实时预览：把分析画布内容复制到展示画布，并叠加轨迹/抛出点
          if (analyzer) {
            const size = analyzer.analysisSize;
            liveCanvas.width = size.width;
            liveCanvas.height = size.height;
            overlayCanvas.width = size.width;
            overlayCanvas.height = size.height;
            liveCanvas.getContext('2d')!.drawImage(analyzer.analysisCanvas, 0, 0);
            const ctx = overlayCanvas.getContext('2d')!;
            drawTrackOverlay(ctx, cal, ev.track.points, ev.origin.point, size);
          }
        },
      });
      statTracks.set(String(summary.trackCount));
      const speed = summary.durationSec > 0 ? summary.durationSec / (summary.wallTimeMs / 1000) : 0;
      statusLine.textContent = cancelRequested
        ? `已停止，共检出 ${events.length} 起事件`
        : `分析完成：${fmtTime(summary.durationSec)} 素材用时 ${(summary.wallTimeMs / 1000).toFixed(1)} 秒（${speed.toFixed(1)}× 实时速度），事件 ${summary.eventCount} 起`;
      toast(cancelRequested ? '分析已停止' : '分析完成，事件已存入事件列表', cancelRequested ? 'info' : 'ok');
      bump();
    } catch (err) {
      console.error(err);
      toast(`分析失败：${(err as Error).message}`, 'error');
      statusLine.textContent = '分析失败';
    } finally {
      startBtn.disabled = false;
      cancelBtn.disabled = true;
      analyzer?.dispose();
      analyzer = null;
    }
  });

  cancelBtn.addEventListener('click', () => {
    cancelRequested = true;
    toast('正在停止…');
  });

  const configCard = el('div', { class: 'card' },
    el('h3', {}, '分析配置'),
    el('label', { class: 'field' }, el('b', {}, '选用标定'), calSelect),
    el('div', { class: 'grid-3', style: 'margin-top:10px' },
      numField('分析长边(px)', 'maxAnalysisEdge', 80, 320, 1920),
      numField('抽帧步长', 'frameStride', 1, 1, 8),
      numField('前景阈值', 'threshold', 2, 8, 90),
    ),
    el('div', { class: 'grid-3', style: 'margin-top:10px' },
      el('label', { class: 'field' }, el('b', {}, '背景学习率 α'), learnInput),
      numField('最小斑点(px)', 'minBlobArea', 2, 2, 200),
      numField('最低抛物评分', 'minThrowScore', 0.05, 0.1, 1),
    ),
    el('div', { class: 'grid-2', style: 'margin-top:10px' },
      el('label', { class: 'field' }, el('b', {}, '昼夜模式'), nightSelect),
      el('label', { class: 'field' }, el('b', {}, `风偏补偿 ${cfg.windCompensation}`), windInput),
    ),
  );

  const runCard = el('div', { class: 'card' },
    el('h3', {}, '任务'),
    el('div', { class: 'row' }, pickBtn, fileLabel),
    el('div', { class: 'row', style: 'margin-top:12px' }, startBtn, cancelBtn),
    el('div', { style: 'margin-top:14px' }, progressWrap, statusLine),
    el('div', { class: 'grid-3', style: 'margin-top:14px' }, statFps.box, statEvents.box, statIr.box),
    el('div', { style: 'margin-top:10px' }, statTracks.box),
  );

  root.append(
    el('div', { class: 'grid-2', style: 'grid-template-columns: 1.4fr 1fr;align-items:start' },
      el('div', {}, configCard, runCard, stage),
      el('div', { class: 'card' }, el('h3', {}, '实时事件'), el('p', { class: 'muted', id: 'feed-hint' }, '分析开始后，确认的抛物事件会实时出现在这里'), eventFeed),
    ),
  );
  return root;
}
