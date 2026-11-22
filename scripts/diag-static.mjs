import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const EDGE = existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push('CONSOLE.' + m.type() + ': ' + m.text()); });
await page.goto('http://localhost:5318/static-debug.html', { waitUntil: 'networkidle' });
try {
  await page.waitForFunction(() => (window).__STATIC_DONE === true, { timeout: 60000 });
} catch {
  errors.push('TIMEOUT partial log: ' + (await page.locator('#log').innerText().catch(() => '<no log>')));
}
console.log(await page.locator('#log').innerText().catch(() => '<no log>'));
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
await browser.close();
