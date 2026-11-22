import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const EDGE = existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('CONSOLE: ' + m.text());
});
await page.goto('http://localhost:5318/gl-debug.html', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__GL_DEBUG_DONE === true, { timeout: 30000 });
const log = await page.locator('#log').innerText();
console.log(log);
if (errors.length) {
  console.log('\n=== ERRORS ===');
  console.log(errors.join('\n'));
  process.exitCode = 1;
}
await browser.close();
