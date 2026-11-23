// 自检页 (#/selftest, 不在导航中): 无头浏览器冒烟测试用
// 合成一段下落物视频帧序列, 跑完整检测管线, 把结果写进 DOM
import { MotionDetector } from '../gl/MotionDetector';
import { extractBlobs } from '../detect/blobs';
import { Tracker } from '../detect/tracker';
import { extractFeatures, classifyTrack } from '../detect/classify';
import { fitTrajectory, backProject } from '../detect/trajectory';
import { cellAt } from '../calib/geometry';
import type { Calibration, TrackPoint } from '../types';

export function selftestPage(root: HTMLElement) {
  const log: string[] = [];
  const say = (s: string) => { log.push(s); console.log('[selftest]', s); };
  const PW = 320, PH = 180;

  try {
    const detector = new MotionDetector(PW, PH, {});
    say('WebGL2 管线初始化成功');

    // 合成帧: 灰底 + 一个沿抛物线下落的黑块
    const src = document.createElement('canvas');
    src.width = PW; src.height = PH;
    const g = src.getContext('2d')!;
    const tracker = new Tracker({ maxDist: 0.08, maxMisses: 5, minHits: 4, maxPoints: 240 });
    const finished: TrackPoint[][] = [];
    const FPS = 30;
    // 抛出点: 归一化 (0.5, 0.2), 模拟从某户抛出
    for (let i = 0; i < 90; i++) {
      const t = i / FPS;
      g.fillStyle = '#808080';
      g.fillRect(0, 0, PW, PH);
      if (t > 0.5) {
        const to = t - 0.5;
        const x = (0.5 + 0.03 * to) * PW;
        const y = (0.2 + 0.02 * to + 0.105 * to * to) * PH;
        g.fillStyle = '#101010';
        g.fillRect(x - 3, y - 3, 6, 6);
      }
      const mask = detector.process(src);
      if (i < 3) continue;
      let sum = 0;
      for (let k = 0; k < mask.length; k++) if (mask[k]) sum++;
      const blobs = extractBlobs(mask, PW, PH, 4, PW * PH * 0.05);
      if (i === 5 || i === 16 || i === 30 || i === 60) say(`帧${i}: 掩膜像素=${sum} blob数=${blobs.length}${blobs[0] ? ` 最大面积=${blobs[0].area}` : ''}`);
      for (const tr of tracker.update(blobs, t, PW, PH)) finished.push(tr.points);
    }
    for (const tr of tracker.flush()) finished.push(tr.points);
    say(`轨迹数: ${finished.length}`);
    if (!finished.length) throw new Error('未跟踪到任何目标');

    const pts = finished.sort((a, b) => b.length - a.length)[0];
    say(`最长轨迹点数: ${pts.length}`);
    const feat = extractFeatures(pts);
    const cls = classifyTrack(feat);
    say(`分类: ${cls} (netDy=${feat.netDy.toFixed(3)}, meanVy=${feat.meanVy.toFixed(2)}, straight=${feat.straightness.toFixed(2)})`);
    if (cls !== 'fall') throw new Error(`分类错误: ${cls}`);

    const calib: Calibration = {
      id: 'st', name: 'selftest', createdAt: 0, imageDataUrl: '', imgW: PW, imgH: PH,
      quad: [{ x: 0.3, y: 0.05 }, { x: 0.7, y: 0.05 }, { x: 0.8, y: 0.95 }, { x: 0.2, y: 0.95 }],
      floors: 10, units: 4, startFloor: 1, unitOrder: 'ltr',
    };
    const fit = fitTrajectory(pts);
    if (!fit) throw new Error('轨迹拟合失败');
    const back = backProject(fit, calib);
    if (!back) throw new Error('回推失败');
    const cell = cellAt(calib, back.throwPoint);
    say(`抛出点: (${back.throwPoint.x.toFixed(3)}, ${back.throwPoint.y.toFixed(3)}) 回推 ${back.backDistance.toFixed(2)}s -> ${cell ? `${cell.floor}层${cell.unit}户` : '网格外'}`);
    // 真实抛出点 (0.5, 0.2): 应在网格内, 且回推点与其接近
    const err = Math.hypot(back.throwPoint.x - 0.5, back.throwPoint.y - 0.2);
    say(`抛出点误差: ${err.toFixed(4)}`);
    if (!cell) throw new Error('抛出点不在标定网格内');
    if (err > 0.05) throw new Error(`抛出点误差过大: ${err}`);

    say('SELFTEST PASS');
    root.innerHTML = `<pre id="result" style="color:#4caf7d">${log.join('\n')}</pre>`;
  } catch (e) {
    say('SELFTEST FAIL: ' + (e as Error).message);
    root.innerHTML = `<pre id="result" style="color:#e05c5c">${log.join('\n')}</pre>`;
  }
}
