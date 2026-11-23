import './style.css';
import { calibrationPage } from './pages/calibrationPage';
import { analysisPage } from './pages/analysisPage';
import { eventsPage } from './pages/eventsPage';
import { reportPage } from './pages/reportPage';
import { synthPage } from './pages/synthPage';
import { selftestPage } from './pages/selftestPage';

const routes: Record<string, (root: HTMLElement) => void> = {
  calib: calibrationPage,
  analyze: analysisPage,
  events: eventsPage,
  report: reportPage,
  synth: synthPage,
  selftest: selftestPage,
};

function render() {
  const hash = location.hash.replace(/^#\/?/, '') || 'calib';
  const name = hash.split('/')[0];
  const app = document.getElementById('app')!;
  app.innerHTML = '';
  document.querySelectorAll('nav a').forEach(a => {
    a.classList.toggle('active', (a as HTMLAnchorElement).dataset.route === name);
  });
  (routes[name] || routes.calib)(app);
}

window.addEventListener('hashchange', render);
render();
