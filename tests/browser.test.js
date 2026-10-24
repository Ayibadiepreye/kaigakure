import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.KAIGAKURE_BROWSER_PORT || '3112';
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'screenshots');

let server;
let browser;

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('server start timeout')), 20000);
    server.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); }
    });
  });
}

test.before(async () => {
  await startServer();
  fs.mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
  if (server && !server.killed) server.kill();
});

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

test('desktop renders the hero and the url bar', async () => {
  const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(SHOTS, 'desktop-home.png'), fullPage: true });

  assert.ok(await page.locator('h1').innerText() === 'Kaigakure');
  assert.ok(await page.locator('#url').isVisible());
  assert.ok(await page.locator('#btnGo').isVisible());
  assert.equal(errors.length, 0, `console errors: ${errors.join(' | ')}`);
  await ctx.close();
});

test('mobile layout has no horizontal overflow', async () => {
  const ctx = await browser.newContext({ viewport: VIEWPORTS.mobile, ...VIEWPORTS.mobile });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(SHOTS, 'mobile-home.png'), fullPage: true });

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px on mobile`);

  // Tap targets should be big enough to hit with a thumb.
  const go = await page.locator('#btnGo').boundingBox();
  assert.ok(go.height >= 40, `button too short: ${go.height}px`);
  await ctx.close();
});

test('the reveal flow populates the selector grid', async () => {
  const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await page.fill('#url', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  await page.click('#btnGo');
  await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });

  const cards = await page.locator('.card').count();
  // One card per piece of content: one video + one audio for a YouTube link.
  assert.ok(cards >= 2, `expected selectable cards, got ${cards}`);
  assert.ok((await page.locator('#title').innerText()).length > 0);

  // A video card with multiple renditions must expose a quality picker.
  const picker = page.locator('.card .variantpick').first();
  assert.ok(await picker.isVisible(), 'expected a quality picker on the video card');
  const options = await picker.locator('option').count();
  assert.ok(options > 5, `expected many quality options, got ${options}`);

  await page.screenshot({ path: path.join(SHOTS, 'desktop-result.png'), fullPage: true });

  // Selecting a card must update the counter and enable the download button.
  const before = await page.locator('#selCount').innerText();
  await page.locator('.card').first().click();
  const after = await page.locator('#selCount').innerText();
  assert.notEqual(before, after, 'selection counter did not change');
  assert.ok(!(await page.locator('#btnDownload').isDisabled()), 'download button stayed disabled');

  // Mode filter: audio-only must show only audio cards.
  await page.click('#mode button[data-m="audio"]');
  await page.waitForTimeout(400);
  const badges = (await page.locator('.card .typebadge').allInnerTexts()).map((b) => b.trim().toLowerCase());
  assert.ok(badges.length > 0, 'audio mode showed nothing');
  assert.ok(badges.every((b) => b === 'audio'), `audio mode leaked: ${badges}`);

  // Back to everything.
  await page.click('#mode button[data-m="all"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-selected.png'), fullPage: true });
  await ctx.close();
});

test('mobile result view is usable', async () => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#url', 'https://soundcloud.com/forss/flickermood');
  await page.click('#btnGo');
  await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
  await page.screenshot({ path: path.join(SHOTS, 'mobile-result.png'), fullPage: true });

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px on mobile results`);
  await ctx.close();
});

test('the app installs as a PWA (manifest + service worker)', async () => {
  const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });

  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? 'registered' : 'none';
  });
  assert.ok(['registered', 'unsupported'].includes(sw), `sw state: ${sw}`);

  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return null;
    const r = await fetch(link.href);
    return r.ok ? await r.json() : null;
  });
  assert.ok(manifest, 'manifest not fetchable');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.length >= 2);
  assert.ok(manifest.share_target, 'no share target configured');
  await ctx.close();
});
