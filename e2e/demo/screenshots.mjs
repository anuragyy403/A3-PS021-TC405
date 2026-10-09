/**
 * npm run demo:screenshots — key screenshots for the deliverables, saved to
 * docs/assets/screenshots/ (committed; each must stay under 400 KB).
 *
 * Also runs the offline-fonts check: with fonts.googleapis.com / fonts.gstatic.com
 * blocked, the dashboard must load at once on system fonts.
 */
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { REPO_ROOT } from '../support/backend.js';
import { runTalkTrack } from './flow.js';
import { FRONTEND_URL, startStack } from './stack.js';

const OUT_DIR = path.join(REPO_ROOT, 'docs', 'assets', 'screenshots');
const LIMIT = 400 * 1024;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
mkdirSync(OUT_DIR, { recursive: true });

const stack = await startStack({ pace: 200 });
const written = [];
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });

  // ---- offline-fonts check -------------------------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const blocked = [];
    await page.route(FONTS, (route) => { blocked.push(route.request().url()); return route.abort(); });
    const t0 = Date.now();
    await page.goto(FRONTEND_URL, { waitUntil: 'load' });
    const loadMs = Date.now() - t0;
    await page.getByText('Live backend', { exact: true }).waitFor();
    const readyMs = Date.now() - t0;
    const fonts = await page.evaluate(() => ({
      webFaces: [...document.fonts].filter((f) => /Inter|JetBrains/.test(f.family) && f.status === 'loaded').length,
      body: getComputedStyle(document.body).fontFamily,
      title: document.title,
    }));
    console.log(`[fonts] blocked ${blocked.length} font request(s); load event after ${loadMs} ms; "Live backend" after ${readyMs} ms`);
    console.log(`[fonts] web font faces loaded: ${fonts.webFaces} (0 = system fallback in use); body font-family: ${fonts.body}`);
    console.log(`[fonts] <title>: ${fonts.title}`);
    if (readyMs > 5000) throw new Error('page took too long without web fonts');
    await context.close();
  }

  // ---- screenshots along the talk track ------------------------------------
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.route(FONTS, (route) => route.abort());   // hermetic and deterministic: system fonts
  await page.goto(FRONTEND_URL);
  await runTalkTrack(page, {
    shot: async (name, target) => {
      const file = path.join(OUT_DIR, `${name}.png`);
      // The dashboard header is sticky; unstick it for the capture so it never covers a panel.
      const style = 'header.sticky { position: static !important; } #demo-caption { display: none !important; }';
      if (target) await target.screenshot({ path: file, animations: 'disabled', style });
      else await page.screenshot({ path: file, animations: 'disabled', style });
      written.push(file);
    },
  });
  await context.close();
} finally {
  await browser?.close();
  await stack.stop();
}

let tooBig = 0;
for (const file of written) {
  const kb = statSync(file).size / 1024;
  if (kb > 400) tooBig += 1;
  console.log(`[demo:screenshots] ${path.relative(REPO_ROOT, file)}  ${kb.toFixed(0)} KB${kb > 400 ? '  (OVER 400 KB)' : ''}`);
}
if (tooBig) {
  console.error(`[demo:screenshots] ${tooBig} file(s) over ${LIMIT / 1024} KB`);
  process.exit(1);
}
