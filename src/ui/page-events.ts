import type { ThrowEvent } from '../core/types';
import { eventStore, calibrationStore } from '../core/storage';
import { el, fmtTime, setState, getState, toast } from './app-state';
import { drawTrackOverlay } from './overlay-draw';

export function renderEventsPage(): HTMLElement {
  const root = el('div');
  root.append(
    el('h1', { class: 'page-title' }, '事件列表'),
    el('p', { class: 'page-desc' }, '所有分析确认的高空抛物事件。点击行查看轨迹与反推详情，可跳转取证报告或删除误报。'),
  );

  const filterCal = el('select', {}) as HTMLSelectElement;
  filterCal.append(el('option', { value: '' }, '全部机位'));
  for (const c of calibrationStore.list()) {
    filterCal.append(el('option', { value: c.id }, c.name));
  }
  const filterInput = el('input', { placeholder: '搜索楼层/户号/视频名…', style: 'min-width:240px' }) as HTMLInputElement;

  const tableBody = el('tbody');
  const detail = el('div');

  function list(): ThrowEvent[] {
    let items = eventStore.list().sort((a, b) => b.createdAt - a.createdAt);
    if (filterCal.value) items = items.filter((e) => e.calibrationId === filterCal.value);
    const q = filterInput.value.trim().toLowerCase();
    if (q) {
      items = items.filter((e) =>
        `${e.origin.cell.floorLabel}${e.origin.cell.unitLabel}${e.videoName}`.toLowerCase().includes(q),
      );
    }
    return items;
  }

  function renderTable(): void {
    tableBody.innerHTML = '';
    const items = list();
    if (items.length === 0) {
      const tr = el('tr', {}, el('td', { colspan: '7', class: 'muted', style: 'text-align:center;padding:30px' }, '暂无事件，先到「视频分析」页运行分析'));
      tableBody.append(tr);
      return;
    }
    for (const ev of items) {
      const cal = calibrationStore.get(ev.calibrationId);
      const selected = getState().selectedEventId === ev.id;
      const tr = el('tr', {
        class: `clickable ${selected ? 'selected-row' : ''}`,
        style: selected ? 'background:#eef4ff' : '',
        onclick: () => {
          setState({ selectedEventId: ev.id });
          renderTable();
          renderDetail(ev);
        },
      },
        el('td', { class: 'mono' }, fmtTime(ev.startSec)),
        el('td', {}, el('span', { class: 'tag danger' }, ev.origin.cell.floorLabel)),
        el('td', {}, el('b', {}, `${ev.origin.cell.unitLabel}户`)),
        el('td', {}, el('span', { class: ev.origin.confidence > 0.6 ? 'tag ok' : 'tag warn' },
          `${(ev.origin.confidence * 100).toFixed(0)}%`)),
        el('td', {}, ev.infrared ? el('span', { class: 'tag info' }, '红外') : el('span', { class: 'tag gray' }, '白昼')),
        el('td', { class: 'muted', style: 'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, ev.videoName),
        el('td', {},
          el('button', {
            class: 'btn secondary',
            style: 'padding:4px 10px;font-size:12px;margin-right:6px',
            onclick: (e: Event) => {
              e.stopPropagation();
              setState({ selectedEventId: ev.id, page: 'report' });
            },
          }, '报告'),
          el('button', {
            class: 'btn danger',
            style: 'padding:4px 10px;font-size:12px',
            onclick: (e: Event) => {
              e.stopPropagation();
              if (confirm('删除该事件？')) {
                eventStore.remove(ev.id);
                detail.innerHTML = '';
                renderTable();
                toast('事件已删除');
              }
            },
          }, '删除'),
        ),
      );
      void cal;
      tableBody.append(tr);
    }
  }

  function renderDetail(ev: ThrowEvent): void {
    detail.innerHTML = '';
    const cal = calibrationStore.get(ev.calibrationId);
    const stage = el('div', { class: 'video-stage' });
    const bg = el('canvas', {}) as HTMLCanvasElement;
    const ov = el('canvas', { class: 'overlay-canvas' }) as HTMLCanvasElement;
    if (ev.thumbnails[0]) {
      const img = new Image();
      img.onload = () => {
        bg.width = img.naturalWidth * 4;
        bg.height = img.naturalHeight * 4;
        bg.getContext('2d')!.drawImage(img, 0, 0, bg.width, bg.height);
        ov.width = bg.width;
        ov.height = bg.height;
        const ctx = ov.getContext('2d')!;
        if (cal) drawTrackOverlay(ctx, cal, ev.track.points, ev.origin.point);
      };
      img.src = ev.thumbnails[0];
    } else {
      bg.width = 640;
      bg.height = 360;
      ov.width = 640;
      ov.height = 360;
      const ctx = ov.getContext('2d')!;
      if (cal) drawTrackOverlay(ctx, cal, ev.track.points, ev.origin.point);
    }
    stage.append(bg, ov);

    const f = ev.track.features;
    const info = el('dl', { class: 'kv' },
      el('dt', {}, '事件编号'), el('dd', { class: 'mono' }, ev.id),
      el('dt', {}, '时间区间'), el('dd', {}, `${fmtTime(ev.startSec)} – ${fmtTime(ev.endSec)}`),
      el('dt', {}, '判定楼层'), el('dd', {}, `${ev.origin.cell.floorLabel}（σ=${ev.origin.floorSigma.toFixed(2)} 层）`),
      el('dt', {}, '判定户号'), el('dd', {}, `${ev.origin.cell.unitLabel}户（σ=${ev.origin.unitSigma.toFixed(2)} 户）`),
      el('dt', {}, '轨迹时长'), el('dd', {}, `${f.durationSec.toFixed(2)} 秒 / ${f.pointCount} 个跟踪点`),
      el('dt', {}, '重力加速度'), el('dd', { class: 'mono' }, `${ev.origin.gravityPx.toFixed(0)} px/s²`),
      el('dt', {}, '拟合残差'), el('dd', { class: 'mono' }, `${ev.origin.fitRmsPx.toFixed(1)} px`),
      el('dt', {}, '分类评分'), el('dd', {}, `${(ev.track.score * 100).toFixed(0)} 分（${ev.track.kind}）`),
    );

    const floorDist = el('div', { class: 'row' });
    for (const p of ev.origin.floorProbabilities.slice(0, 4)) {
      floorDist.append(el('span', { class: 'tag info' }, `${p.floorLabel} ${(p.prob * 100).toFixed(0)}%`));
    }
    const unitDist = el('div', { class: 'row' });
    for (const p of ev.origin.unitProbabilities.slice(0, 4)) {
      unitDist.append(el('span', { class: 'tag info' }, `${p.unitLabel}户 ${(p.prob * 100).toFixed(0)}%`));
    }

    const reasons = el('ul', { style: 'margin:6px 0 0;padding-left:18px' });
    for (const r of ev.origin.reasons) reasons.append(el('li', { class: 'muted' }, r));

    detail.append(
      el('div', { class: 'card' },
        el('h3', {}, '事件详情'),
        el('div', { class: 'grid-2', style: 'grid-template-columns:1.3fr 1fr;align-items:start' },
          stage,
          el('div', {},
            info,
            el('h4', { style: 'margin:14px 0 6px' }, '楼层概率分布'), floorDist,
            el('h4', { style: 'margin:14px 0 6px' }, '户号概率分布'), unitDist,
            el('h4', { style: 'margin:14px 0 6px' }, '判定依据'), reasons,
            el('div', { class: 'row', style: 'margin-top:16px' },
              el('button', {
                class: 'btn',
                onclick: () => setState({ selectedEventId: ev.id, page: 'report' }),
              }, '生成取证报告'),
            ),
          ),
        ),
      ),
    );
  }

  filterCal.addEventListener('change', renderTable);
  filterInput.addEventListener('input', renderTable);

  root.append(
    el('div', { class: 'card' },
      el('div', { class: 'row', style: 'justify-content:space-between' },
        el('div', { class: 'row' }, filterCal, filterInput),
        el('button', {
          class: 'btn ghost',
          onclick: () => {
            if (confirm('清空全部事件？此操作不可恢复。')) {
              eventStore.clear();
              detail.innerHTML = '';
              renderTable();
            }
          },
        }, '清空全部'),
      ),
      el('table', { style: 'margin-top:12px' },
        el('thead', {}, el('tr', {},
          el('th', {}, '时间'), el('th', {}, '楼层'), el('th', {}, '户号'),
          el('th', {}, '置信度'), el('th', {}, '模式'), el('th', {}, '来源视频'), el('th', {}, '操作'),
        )),
        tableBody,
      ),
    ),
    detail,
  );

  renderTable();
  const preselected = eventStore.list().find((e) => e.id === getState().selectedEventId);
  if (preselected) renderDetail(preselected);
  return root;
}
