// 事件列表页
import { store } from '../store';

export function eventsPage(root: HTMLElement) {
  const events = store.events().sort((a, b) => b.wallTime - a.wallTime);

  root.innerHTML = `
    <h2>事件列表 <span class="badge">${events.length}</span></h2>
    <div class="panel">
      <div class="row" style="margin-bottom:10px">
        <input type="text" id="q" placeholder="按户号 / 视频名筛选" style="width:220px">
        <button class="ghost" id="bExport">导出 JSON</button>
        <button class="danger" id="bClear">清空全部</button>
      </div>
      <table id="tbl">
        <tr><th>截图</th><th>户号</th><th>视频时间</th><th>所在录像</th><th>置信度</th><th>物体推测</th><th>操作</th></tr>
      </table>
    </div>`;

  const tbl = root.querySelector<HTMLTableElement>('#tbl')!;

  function render(filter: string) {
    tbl.querySelectorAll('tr.data').forEach(r => r.remove());
    for (const e of events) {
      if (filter && !e.label.includes(filter) && !e.videoName.includes(filter)) continue;
      const tr = document.createElement('tr');
      tr.className = 'data';
      const cls = e.confidence >= 0.7 ? 'ok' : e.confidence >= 0.45 ? 'warn' : 'bad';
      tr.innerHTML = `
        <td><img class="thumb" src="${e.thumbnail}" alt=""></td>
        <td><b style="font-size:16px">${e.label}</b><br><span class="hint">${e.floor}层 ${e.unit}户</span></td>
        <td>${fmtT(e.videoTime)}</td>
        <td class="hint">${e.videoName}</td>
        <td><span class="badge ${cls}">${(e.confidence * 100).toFixed(0)}%</span></td>
        <td class="hint">${e.objectGuess}</td>
        <td></td>`;
      const td = tr.lastElementChild!;
      const bRep = document.createElement('button');
      bRep.className = 'ghost'; bRep.textContent = '取证报告';
      bRep.onclick = () => { location.hash = '#/report/' + e.id; };
      const bDel = document.createElement('button');
      bDel.className = 'danger'; bDel.textContent = '删除'; bDel.style.marginLeft = '6px';
      bDel.onclick = () => { store.deleteEvent(e.id); events.splice(events.indexOf(e), 1); render((root.querySelector('#q') as HTMLInputElement).value); };
      td.append(bRep, bDel);
      tbl.appendChild(tr);
    }
  }

  root.querySelector('#q')!.addEventListener('input', e => render((e.target as HTMLInputElement).value.trim()));
  root.querySelector('#bExport')!.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `抛物事件_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  root.querySelector('#bClear')!.addEventListener('click', () => {
    if (confirm('确定清空全部事件?')) { store.clearEvents(); events.length = 0; render(''); }
  });

  render('');
}

function fmtT(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
