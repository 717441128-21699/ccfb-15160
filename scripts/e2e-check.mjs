/**
 * 端到端验证：在本机 Edge 中启动应用，
 * 合成测试视频 → 跑完整 WebGL2 分析链路 → 抓取验收指标。
 * 用法：node scripts/e2e-check.mjs [baseUrl]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5199/';
const EDGE_X86 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_X64 = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const edgePath = existsSync(EDGE_X86) ? EDGE_X86 : EDGE_X64;

const logs = [];
const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const fail = (msg) => {
  console.error(`\n❌ ${msg}`);
  console.log(logs.join('\n'));
  process.exitCode = 1;
};

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const webgl2 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  });
  console.log(`WebGL2 supported in headless Edge: ${webgl2}`);
  if (!webgl2) throw new Error('WebGL2 不可用，无法继续');

  // 冒烟：标定页渲染
  await page.getByRole('button', { name: '楼栋标定' }).click();
  await page.waitForSelector('canvas', { timeout: 10000 });
  console.log('✓ 楼栋标定页渲染正常');

  // 进入合成测试页
  await page.getByRole('button', { name: '合成测试' }).click();
  await page.waitForSelector('select', { timeout: 10000 });

  // 缩短时长，控制无头环境运行时间
  await page.locator('input[type="number"]').nth(1).fill('40'); // 时长（秒），事件间隔约 5s，贴近真实监控
  await page.locator('input[type="number"]').nth(2).fill('6'); // 事件数

  const t0 = Date.now();
  await page.getByRole('button', { name: '生成视频并自动验收' }).click();
  console.log('已启动合成+分析任务，等待完成…');

  // 等待结果卡片（达标/未达标标签出现）
  await page.waitForSelector('.card .tag.ok, .card .tag.danger', { timeout: 240000 });
  await page.waitForFunction(
    () => !document.querySelector('.progress-bar')?.style.width ||
      document.querySelector('.progress-bar')?.style.width === '100%',
    { timeout: 240000 },
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const metrics = await page.evaluate(() => {
    const stats = [...document.querySelectorAll('.stat')].map((s) => s.innerText.replace(/\n/g, ' '));
    const rows = [...document.querySelectorAll('table tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()),
    );
    const banner = document.querySelector('.card h3')?.innerText ?? '';
    return { stats, rows, banner };
  });

  console.log(`\n任务总耗时（合成+分析）：${elapsed}s`);
  console.log(`结论横幅：${metrics.banner}`);
  console.log('\n指标卡片：');
  for (const s of metrics.stats.slice(0, 6)) console.log('  -', s);
  console.log(`\n逐事件比对（${metrics.rows.length} 行）：`);
  for (const r of metrics.rows) console.log('  ', r.join(' | '));

  const pageErrors = logs.filter((l) => l.includes('pageerror'));
  if (pageErrors.length) fail(`页面存在 JS 错误：\n${pageErrors.join('\n')}`);
  else console.log('\n✓ 无页面 JS 错误');

  // 事件列表页冒烟
  await page.getByRole('button', { name: '事件列表' }).click();
  await page.waitForTimeout(500);
  const eventRows = await page.locator('table tbody tr').count();
  console.log(`✓ 事件列表页渲染，行数=${eventRows}`);

  // 先点击第一个事件行选中，再进入取证报告页（报告页依赖选中事件）
  if (eventRows > 0) {
    await page.locator('table tbody tr').first().click();
    await page.waitForTimeout(300);
  }
  await page.getByRole('button', { name: '取证报告', exact: true }).click();
  await page.waitForTimeout(1000);
  const reportText = await page.locator('main').innerText();
  const hasReport = reportText.includes('溯源结论') && reportText.includes('运动学分析');
  console.log(`${hasReport ? '✓' : '✗'} 取证报告页内容${hasReport ? '完整' : '缺失'}`);
  if (!hasReport) fail('取证报告内容缺失');

  await page.screenshot({ path: 'e2e-result.png', fullPage: true });
  console.log('✓ 截图已保存 e2e-result.png');
} catch (err) {
  fail(`E2E 异常：${err.message}`);
  try {
    await page.screenshot({ path: 'e2e-fail.png', fullPage: true });
  } catch { /* ignore */ }
} finally {
  await browser.close();
}
