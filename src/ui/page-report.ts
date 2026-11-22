import { eventStore, calibrationStore } from '../core/storage';
import { el, fmtTime, getState, setState, toast } from './app-state';
import { drawTrackOverlay } from './overlay-draw';

export function renderReportPage(): HTMLElement {
  const root = el('div');
  const eventId = getState().selectedEventId;
  const ev = eventStore.list().find((e) => e.id === eventId);

  root.append(
    el('h1', { class: 'page-title' }, '取证报告'),
    el('p', { class: 'page-desc' }, '报告可直接打印或另存为 PDF（浏览器打印对话框），也可导出结构化 JSON 归档。'),
  );

  if (!ev) {
    root.append(el('div', { class: 'empty' },
      el('p', {}, '尚未选择事件'),
      el('button', { class: 'btn', onclick: () => setState({ page: 'events' }) }, '前往事件列表'),
    ));
    return root;
  }

  const cal = calibrationStore.get(ev.calibrationId);
  const reportId = `RPT-${new Date(ev.createdAt).toISOString().slice(0, 10).replaceAll('-', '')}-${ev.id.slice(-4).toUpperCase()}`;

  // 证据图：网格 + 轨迹 + 抛出点
  const evidenceCanvas = el('canvas', { width: 960, height: 540 }) as HTMLCanvasElement;
  const ectx = evidenceCanvas.getContext('2d')!;
  ectx.fillStyle = '#0d1420';
  ectx.fillRect(0, 0, 960, 540);
  if (ev.thumbnails[0]) {
    const img = new Image();
    img.onload = () => {
      ectx.fillStyle = '#0d1420';
      ectx.fillRect(0, 0, 960, 540);
      ectx.drawImage(img, 0, 0, 960, 540);
      if (cal) drawTrackOverlay(ectx, cal, ev.track.points, ev.origin.point);
    };
    img.src = ev.thumbnails[0];
  } else if (cal) {
    drawTrackOverlay(ectx, cal, ev.track.points, ev.origin.point);
  }

  const f = ev.track.features;
  const headerCard = el('div', { class: 'card report-section' },
    el('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
      el('div', {},
        el('h2', { style: 'border:none;padding:0;margin:0 0 6px' }, '高空抛物事件取证报告'),
        el('div', { class: 'muted mono' }, `报告编号：${reportId}`),
        el('div', { class: 'muted', style: 'margin-top:4px' }, `生成时间：${new Date(ev.createdAt).toLocaleString('zh-CN')}`),
      ),
      el('div', { class: 'row no-print' },
        el('button', { class: 'btn', onclick: () => window.print() }, '打印 / 另存 PDF'),
        el('button', { class: 'btn secondary', onclick: () => exportJson() }, '导出 JSON'),
      ),
    ),
  );

  function exportJson(): void {
    const payload = {
      reportId,
      event: ev,
      calibration: cal ?? null,
      exportedAt: new Date().toISOString(),
      tool: '高空抛物溯源分析平台 v1.0',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `${reportId}.json` }) as HTMLAnchorElement;
    a.click();
    URL.revokeObjectURL(url);
    toast('JSON 已导出', 'ok');
  }

  const conclusion = el('div', { class: 'card report-section' },
    el('h2', {}, '一、溯源结论'),
    el('div', { class: 'grid-3' },
      conclusionBox('判定楼层', ev.origin.cell.floorLabel, `相邻楼层标准差 ${ev.origin.floorSigma.toFixed(2)} 层`),
      conclusionBox('判定户号', `${ev.origin.cell.unitLabel}户`, `相邻户号标准差 ${ev.origin.unitSigma.toFixed(2)} 户`),
      conclusionBox('综合置信度', `${(ev.origin.confidence * 100).toFixed(0)}%`, ev.origin.confidence > 0.6 ? '可信度较高' : '建议人工复核'),
    ),
    el('dl', { class: 'kv', style: 'margin-top:14px' },
      el('dt', {}, '来源视频'), el('dd', {}, ev.videoName),
      el('dt', {}, '机位标定'), el('dd', {}, cal ? `${cal.name}（${cal.floors}层×${cal.units}户，仰角${cal.cameraElevationDeg}°）` : '标定已删除'),
      el('dt', {}, '事件时段'), el('dd', { class: 'mono' }, `${fmtTime(ev.startSec)} – ${fmtTime(ev.endSec)}（帧 ${ev.startFrame}–${ev.endFrame}）`),
      el('dt', {}, '画面模式'), el('dd', {}, ev.infrared ? '红外夜间画面' : '白昼可见光画面'),
      el('dt', {}, '估计出手时刻'), el('dd', { class: 'mono' }, `${fmtTime(Math.max(0, ev.origin.launchTimeSec))}（相对视频起点）`),
    ),
  );

  const evidence = el('div', { class: 'card report-section' },
    el('h2', {}, '二、轨迹证据图'),
    el('div', { class: 'video-stage' }, evidenceCanvas),
    el('p', { class: 'muted', style: 'margin-top:8px;font-size:12px' },
      '黄色折线为下落物体跟踪轨迹，红色十字为沿抛物线反推的抛出点，蓝线为楼面透视网格。'),
  );

  const probCard = el('div', { class: 'card report-section' },
    el('h2', {}, '三、楼层 / 户号概率分布'),
    el('div', { class: 'grid-2' },
      probTable('楼层', ev.origin.floorProbabilities.map((p) => p.floorLabel), ev.origin.floorProbabilities.map((p) => p.prob)),
      probTable('户号', ev.origin.unitProbabilities.map((p) => `${p.unitLabel}户`), ev.origin.unitProbabilities.map((p) => p.prob)),
    ),
  );

  const physics = el('div', { class: 'card report-section' },
    el('h2', {}, '四、运动学分析'),
    el('dl', { class: 'kv' },
      el('dt', {}, '跟踪点数'), el('dd', {}, `${f.pointCount} 个`),
      el('dt', {}, '轨迹时长'), el('dd', {}, `${f.durationSec.toFixed(2)} 秒`),
      el('dt', {}, '竖直下落量'), el('dd', { class: 'mono' }, `${f.verticalDrop.toFixed(1)} px`),
      el('dt', {}, '水平漂移量'), el('dd', { class: 'mono' }, `${f.horizontalDrift.toFixed(1)} px`),
      el('dt', {}, '重力项系数'), el('dd', { class: 'mono' }, `${ev.origin.gravityPx.toFixed(1)} px/s²`),
      el('dt', {}, '抛物线拟合残差'), el('dd', { class: 'mono' }, `${ev.origin.fitRmsPx.toFixed(2)} px（RMS，越小越符合自由落体）`),
      el('dt', {}, '路径直线度'), el('dd', { class: 'mono' }, f.straightness.toFixed(3)),
      el('dt', {}, '向下运动占比'), el('dd', { class: 'mono' }, `${(f.downwardRatio * 100).toFixed(0)}%`),
      el('dt', {}, '平均目标面积'), el('dd', { class: 'mono' }, `${f.meanArea.toFixed(1)} px²（变异系数 ${f.areaCv.toFixed(2)}）`),
    ),
    el('h4', { style: 'margin:14px 0 6px' }, '判定依据'),
    el('ul', { style: 'margin:0;padding-left:18px' }, ...ev.origin.reasons.map((r) => el('li', { class: 'muted' }, r))),
  );

  const disclaimer = el('div', { class: 'card report-section' },
    el('h2', {}, '五、取证说明'),
    el('ol', { style: 'margin:0;padding-left:20px;color:var(--fg-2)' },
      el('li', {}, '本报告由算法基于监控视频自动生成，抛出点为抛物线运动学反推结果，存在标定与拟合误差，概率分布已量化该不确定性。'),
      el('li', {}, '雨滴、飞鸟、风吹树叶等干扰已通过面积、路径直线度、重力加速度与形态波动特征过滤，但不排除极端相似运动造成误判。'),
      el('li', {}, '建议结合原始视频对应时段回放、现场走访与其他机位画面综合认定，本报告作为线索与证据辅助材料使用。'),
      el('li', {}, '原始视频未上传任何服务器，全部分析在本机浏览器内完成。'),
    ),
  );

  root.append(headerCard, conclusion, evidence, probCard, physics, disclaimer);
  return root;
}

function conclusionBox(label: string, value: string, hint: string): HTMLElement {
  return el('div', { class: 'stat', style: 'border-left:4px solid var(--danger)' },
    el('div', { class: 'lbl' }, label),
    el('div', { style: 'font-size:24px;font-weight:700;margin:4px 0' }, value),
    el('div', { class: 'muted', style: 'font-size:12px' }, hint),
  );
}

function probTable(title: string, labels: string[], probs: number[]): HTMLElement {
  const max = Math.max(...probs, 0.0001);
  const rows = labels.map((lab, i) =>
    el('tr', {},
      el('td', { style: 'width:90px;white-space:nowrap' }, lab),
      el('td', {},
        el('div', { style: 'display:flex;align-items:center;gap:8px' },
          el('div', { style: 'flex:1;height:10px;background:#e8edf5;border-radius:99px;overflow:hidden' },
            el('div', {
              style: `width:${(probs[i] / max) * 100}%;height:100%;background:var(--primary);border-radius:99px`,
            }),
          ),
          el('span', { class: 'mono', style: 'width:52px;text-align:right' }, `${(probs[i] * 100).toFixed(1)}%`),
        ),
      ),
    ),
  );
  return el('div', {},
    el('b', { style: 'display:block;margin-bottom:8px' }, `${title}候选概率`),
    el('table', {}, el('tbody', {}, ...rows)),
  );
}
