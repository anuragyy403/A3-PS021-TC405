/**
 * npm run report:pdf — builds the submission PDFs with Playwright + the installed
 * Microsoft Edge (no browser download):
 *
 *   docs/submission/report.html → docs/submission/Nighthawks-PS-021-Report.pdf  (A4, page numbers)
 *   docs/submission/deck.html   → docs/submission/Nighthawks-PS-021-Deck.pdf    (16:9 slides)
 *
 * Offline: every request made while rendering is logged; anything that is not
 * file: or data: fails the build.  Every <img> must have loaded.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { REPO_ROOT } from '../support/backend.js';

const DIR = path.join(REPO_ROOT, 'docs', 'submission');
const JOBS = [
  {
    html: 'report.html',
    pdf: 'Nighthawks-PS-021-Report.pdf',
    options: {
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%; font-size:8px; color:#64748b; padding:0 17mm; display:flex; justify-content:space-between; font-family:Segoe UI, Arial, sans-serif;">
        <span>Nighthawks · PS-021 · experimental prototype</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
      margin: { top: '18mm', bottom: '20mm', left: '17mm', right: '17mm' },
    },
  },
  {
    html: 'deck.html',
    pdf: 'Nighthawks-PS-021-Deck.pdf',
    options: { printBackground: true, preferCSSPageSize: true },
  },
];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
let failed = false;
try {
  for (const job of JOBS) {
    const page = await browser.newPage();
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    const failures = [];
    page.on('requestfailed', (r) => failures.push(`${r.url()} (${r.failure()?.errorText})`));

    await page.goto(pathToFileURL(path.join(DIR, job.html)).href, { waitUntil: 'load' });
    const images = await page.evaluate(async () => {
      const imgs = [...document.images];
      await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))));
      return imgs.map((img) => ({ src: img.getAttribute('src'), ok: img.complete && img.naturalWidth > 0 }));
    });
    const out = path.join(DIR, job.pdf);
    await page.pdf({ path: out, ...job.options });
    await page.close();

    const external = requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:'));
    const broken = images.filter((i) => !i.ok);
    const kb = (statSync(out).size / 1024).toFixed(0);
    console.log(`[report:pdf] ${path.relative(REPO_ROOT, out)}  ${kb} KB · ${requests.length} requests (all local: ${external.length === 0}) · ${images.length} images (broken: ${broken.length})`);
    for (const u of external) console.error(`  EXTERNAL REQUEST: ${u}`);
    for (const f of failures) console.error(`  FAILED REQUEST: ${f}`);
    for (const b of broken) console.error(`  BROKEN IMAGE: ${b.src}`);
    if (external.length || failures.length || broken.length) failed = true;
  }
} finally {
  await browser.close();
}
if (failed) {
  console.error('[report:pdf] FAILED — see above');
  process.exit(1);
}
