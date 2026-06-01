// One-off: capture real dark-theme screenshots of the running Mini App for the
// landing's device frames. Drives the locally-running app (PORT 8099 with
// AUTH_DEV_BYPASS) via system Chrome, sets debugUserId per role, forces dark
// theme, and writes phone-aspect PNGs (1:2.08, @2x) into landing/public/screens.
//
// Prereq: local stack running and seeded (see CLAUDE.md "Local dev").
// Run: node scripts/capture-screens.cjs
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:8099';
const OUT = path.join(__dirname, '..', 'landing', 'public', 'screens');
const W = 390;
const H = Math.round(W * 2.08); // 811 — matches PhoneFrame aspect

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(browser, { name, user, route, prep }) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'dark' },
  ]);
  await page.evaluateOnNewDocument((uid) => {
    localStorage.setItem('debugUserId', uid);
    // force dark before app boot; app's applyTheme keeps it in dev (OS = dark)
    document.documentElement.dataset.theme = 'dark';
  }, String(user));
  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await sleep(900); // fonts + QR canvas
  if (prep) await prep(page);
  await sleep(500);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, type: 'png' });
  console.log('captured', name, '->', file);
  await page.close();
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars'],
  });

  // click a bottom-tab by its visible label, then wait for content
  const clickTab = (label) => async (page) => {
    await page.evaluate((l) => {
      const t = [...document.querySelectorAll('.m-tab')].find((e) =>
        e.textContent.trim().startsWith(l),
      );
      if (t) t.click();
    }, label);
    await sleep(700);
  };
  // scroll a specific element to the top (skips the redemption-hold card so the
  // QR frame leads with the balance + rotating QR)
  const scrollToEl = (sel) => async (page) => {
    await page.evaluate((s) => {
      const el = document.querySelector(s)?.closest('.card') || document.querySelector(s);
      if (el) el.scrollIntoView({ block: 'start' });
    }, sel);
    await sleep(400);
  };
  // scroll a section heading to the top of the user screen
  const scrollTo = (text) => async (page) => {
    await page.evaluate((t) => {
      const el = [...document.querySelectorAll('.card h3, .card')].find((e) =>
        e.textContent.includes(t),
      );
      if (el) el.scrollIntoView({ block: 'start' });
    }, text);
    await sleep(400);
  };

  await shot(browser, { name: 'admin-program', user: 111, route: '/admin', prep: clickTab('Program') });
  await shot(browser, { name: 'admin-scan', user: 222, route: '/admin' });
  await shot(browser, { name: 'app-qr', user: 999, route: '/app', prep: scrollToEl('.balance') });
  await shot(browser, { name: 'app-rewards', user: 999, route: '/app', prep: scrollTo('Rewards') });
  await shot(browser, { name: 'app-history', user: 999, route: '/app', prep: scrollTo('History') });

  await browser.close();
  console.log('done');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
