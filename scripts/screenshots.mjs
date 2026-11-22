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
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:5317/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: 'shot-calibration.png' });

for (const name of ['视频分析', '事件列表', '合成测试', '取证报告']) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `shot-${name}.png` });
}
console.log('screenshots done');
await browser.close();
