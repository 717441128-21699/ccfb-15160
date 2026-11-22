import { getState, setState, subscribe } from './ui/app-state';
import { renderCalibrationPage } from './ui/page-calibration';
import { renderAnalysisPage } from './ui/page-analysis';
import { renderEventsPage } from './ui/page-events';
import { renderReportPage } from './ui/page-report';
import { renderTestPage } from './ui/page-test';
import { GlMotionDetector } from './gl/detector';

const NAV: Array<{ id: string; label: string }> = [
  { id: 'calibration', label: '楼栋标定' },
  { id: 'analysis', label: '视频分析' },
  { id: 'events', label: '事件列表' },
  { id: 'report', label: '取证报告' },
  { id: 'test', label: '合成测试' },
];

function render(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = '';
  const state = getState();

  const header = document.createElement('header');
  header.className = 'app-header';
  const title = document.createElement('div');
  title.className = 'app-title';
  title.innerHTML = '高空抛物溯源分析平台 <small>WebGL2 本地检测 · 抛物线反推定户</small>';
  const nav = document.createElement('nav');
  nav.className = 'nav';
  for (const item of NAV) {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    if (state.page === item.id) btn.classList.add('active');
    btn.addEventListener('click', () => setState({ page: item.id as typeof state.page }));
    nav.append(btn);
  }
  header.append(title, nav);

  const main = document.createElement('main');
  main.className = 'app-main';
  switch (state.page) {
    case 'calibration':
      main.append(renderCalibrationPage());
      break;
    case 'analysis':
      main.append(renderAnalysisPage());
      break;
    case 'events':
      main.append(renderEventsPage());
      break;
    case 'report':
      main.append(renderReportPage());
      break;
    case 'test':
      main.append(renderTestPage());
      break;
  }
  app.append(header, main);
}

subscribe(render);
render();

if (!GlMotionDetector.isSupported()) {
  // 首屏提示一次，分析页内也有兜底
  console.warn('WebGL2 不可用，检测功能将无法运行');
}
