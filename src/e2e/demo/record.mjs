/**
 * npm run demo:record   — backup video of the talk track (not part of npm run e2e).
 *
 * Boots its own stack (backend :3101 on a temp DB, Vite :5199, pace 900 ms),
 * plays docs/DEMO_SCRIPT.md steps 1–6 and 8 in Edge with on-screen captions and
 * pauses, and saves a .webm to e2e/demo-output/ (gitignored).
 */
import { mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { caption, runTalkTrack } from './flow.js';
import { FRONTEND_URL, startStack } from './stack.js';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo-output');
const SIZE = { width: 1440, height: 900 };

mkdirSync(OUT_DIR, { recursive: true });
const started = Date.now();
const stack = await startStack({ pace: 900 });
let browser;
let videoPath = null;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: !process.argv.includes('--headed') });
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT_DIR, size: SIZE } });
  const page = await context.newPage();
  await page.goto(FRONTEND_URL);

  await caption(page, 'Nighthawks · PS-021 — dialog correlation and recovery (experimental prototype)');
  await page.waitForTimeout(3000);
  await runTalkTrack(page, {
    pause: (ms) => page.waitForTimeout(ms),
    say: (text) => caption(page, text),
  });
  await caption(page, 'Same dialog_id / task_id throughout · work never repeated · experimental, not exactly-once');
  await page.waitForTimeout(3000);

  const video = page.video();
  await context.close();                       // finalises the video file
  const recorded = await video.path();
  videoPath = path.join(OUT_DIR, `nighthawks-demo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`);
  renameSync(recorded, videoPath);
} finally {
  await browser?.close();
  await stack.stop();
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const size = (statSync(videoPath).size / (1024 * 1024)).toFixed(1);
console.log(`[demo:record] ${videoPath}`);
console.log(`[demo:record] ${size} MB, recorded in ${seconds} s (wall clock including server start/stop)`);
