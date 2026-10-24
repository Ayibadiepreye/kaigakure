const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

(async () => {
  const svg = fs.readFileSync(path.join(PUBLIC_DIR, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const sizes = [
    { file: 'icon-192.png', size: 192 },
    { file: 'icon-512.png', size: 512 },
    { file: 'icon-maskable.png', size: 512 },
  ];
  for (const s of sizes) {
    const page = await browser.newPage({
      viewport: { width: s.size, height: s.size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<html><body style="margin:0;background:#0a0b14;width:${s.size}px;height:${s.size}px;display:grid;place-items:center">
        <div style="width:${s.size}px;height:${s.size}px">${svg.replace('<svg', `<svg width="${s.size}" height="${s.size}"`)}</div>
      </body></html>`
    );
    await page.screenshot({ path: path.join(PUBLIC_DIR, s.file), omitBackground: false });
    await page.close();
    console.log('wrote', s.file);
  }
  await browser.close();
})();
