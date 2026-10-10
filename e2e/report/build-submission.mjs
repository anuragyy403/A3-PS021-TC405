/**
 * npm run report:submission — builds the organizer-format submission PDF with
 * Playwright + the installed Microsoft Edge (no browser download):
 *
 *   docs/submission/A3-PS021-TC405.html → docs/submission/A3-PS021-TC405.pdf
 *
 * Slide size comes from the page's @page rule (160 mm × 90 mm, the template's size).
 * Offline: any request that is not file:/data: fails the build; every <img> must load.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { REPO_ROOT } from '../support/backend.js';

const DIR = path.join(REPO_ROOT, 'docs', 'submission');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(pathToFileURL(path.join(DIR, 'A3-PS021-TC405.html')).href, { waitUntil: 'load' });
  const images = await page.evaluate(async () => {
    const imgs = [...document.images];
    await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))));
    return imgs.map((img) => ({ src: img.getAttribute('src'), ok: img.complete && img.naturalWidth > 0 }));
  });
  // A slide overflows if any content (not header/footer) reaches the footer line or the slide edge.
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.slide')].map((s, i) => {
    const box = s.getBoundingClientRect();
    const ftr = s.querySelector('.ftr');
    const limit = ftr ? ftr.getBoundingClientRect().top - 2 : box.bottom;
    const els = [...s.querySelectorAll('*')].filter((e) => !e.closest('.ftr') && !e.closest('.hdr') && e.getClientRects().length);
    const over = els.some((e) => { const r = e.getBoundingClientRect(); return r.bottom > limit || r.right > box.right + 1; });
    return over ? i + 1 : null;
  }).filter(Boolean));
  const out = path.join(DIR, 'A3-PS021-TC405.pdf');
  await page.pdf({ path: out, printBackground: true, preferCSSPageSize: true });
  const external = requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:'));
  const broken = images.filter((i) => !i.ok);
  console.log(`${path.basename(out)}: ${(statSync(out).size / 1024).toFixed(0)} KB, ${images.length} images, ${requests.length} requests`);
  if (overflow.length) { console.error(`FAILED: content reaches the footer on slide(s) ${overflow.join(', ')}`); process.exitCode = 1; }
  if (external.length || broken.length) {
    console.error('FAILED', { external, broken });
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
