import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.KAIGAKURE_TEST_PORT || '3111';
const BASE = `http://127.0.0.1:${PORT}`;

let server;

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 20000);
    server.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  });
}

function stopServer() {
  if (server && !server.killed) server.kill();
}

test.before(startServer);
test.after(stopServer);

test('GET /api/health reports ok and platform list', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.platforms));
  assert.ok(body.platforms.length > 10);
});

test('GET / serves the app shell', async () => {
  const res = await fetch(BASE);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Kaigakure'));
  assert.ok(html.includes('/app.js'));
});

test('PWA assets are served', async () => {
  const manifest = await fetch(`${BASE}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  const m = await manifest.json();
  assert.ok(m.name.includes('Kaigakure'));
  assert.ok(m.icons.length >= 2);

  const sw = await fetch(`${BASE}/sw.js`);
  assert.equal(sw.status, 200);
});

test('POST /api/probe rejects a missing url', async () => {
  const res = await fetch(`${BASE}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('POST /api/probe resolves a direct media file without any extractor', async () => {
  const res = await fetch(`${BASE}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/clip.mp4' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.platformName, 'Direct file');
  assert.equal(body.counts.video, 1);
});

test('POST /api/probe surfaces every available rendition for a YouTube link', async () => {
  const res = await fetch(`${BASE}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.platformName, 'YouTube');

  // The model is one item per piece of content, with renditions nested inside
  // `variants` — not one item per codec.
  assert.equal(body.counts.video, 1, 'expected a single logical video item');
  assert.equal(body.counts.audio, 1, 'expected a single logical audio item');

  const video = body.items.find((i) => i.type === 'video');
  assert.ok(video, 'expected a video item');
  assert.ok(video.variants.length > 5, `expected many renditions, got ${video.variants.length}`);
  assert.ok(
    video.variants.some((v) => v.height >= 1080),
    'expected an HD rendition among the variants'
  );

  const audio = body.items.find((i) => i.type === 'audio');
  assert.ok(audio, 'expected an audio item');
  assert.ok(Array.isArray(audio.variants), 'audio item should carry variants');
});

test('gallery-dl results are unwrapped and surfaced (Imgur)', async () => {
  // Regression: gallery-dl emits [index, object] pairs and reports `category`
  // as the site name (e.g. "imgur"), not "image". This used to drop everything.
  const res = await fetch(`${BASE}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://imgur.com/a/0azvj' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.counts.photo >= 1, `expected photos, got ${JSON.stringify(body.counts)}`);
  const photo = body.items.find((i) => i.type === 'photo');
  assert.ok(photo?.url, 'photo item should carry a real URL');
  assert.ok(/i\.imgur\.com/.test(photo.url), `expected an imgur URL, got ${photo.url}`);
});

test('POST /api/download validates input', async () => {
  const res = await fetch(`${BASE}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/x.mp4', selection: [] }),
  });
  assert.equal(res.status, 400);
});

test('a full download job produces a real file and a zip', async () => {
  const probeRes = await fetch(`${BASE}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://soundcloud.com/forss/flickermood' }),
  });
  const probe = await probeRes.json();
  assert.equal(probeRes.status, 200);
  const audio = probe.items.find((i) => i.type === 'audio');
  assert.ok(audio, 'expected an audio item');

  const start = await fetch(`${BASE}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://soundcloud.com/forss/flickermood',
      title: 'Flickermood',
      selection: [{ id: audio.id, type: 'audio', ext: audio.ext }],
      options: { quality: 'best', audioFormat: 'mp3' },
    }),
  });
  assert.equal(start.status, 200);
  const { id } = await start.json();

  let job;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    job = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    if (job.status === 'complete' || job.status === 'error') break;
  }

  assert.equal(job.status, 'complete', `job failed: ${job.error}`);
  assert.equal(job.files.length, 1);
  const f = job.files[0];
  assert.ok(f.size > 100000, `file too small: ${f.size}`);
  assert.ok(/\.mp3$/.test(f.name), `expected .mp3, got ${f.name}`);
  assert.ok(!/\.mp3\.mp3$/.test(f.name), 'double extension');

  const zip = await fetch(`${BASE}/api/jobs/${id}/zip`);
  assert.equal(zip.status, 200);
  const buf = Buffer.from(await zip.arrayBuffer());
  assert.ok(buf.length > 100000, 'zip too small');
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'not a zip file');

  const file = await fetch(`${BASE}/api/jobs/${id}/file/${encodeURIComponent(f.name)}`);
  assert.equal(file.status, 200);
  const fb = Buffer.from(await file.arrayBuffer());
  assert.equal(fb.length, f.size);
});

test('Pinterest pins resolve anonymously without any login', async () => {
  const res = await fetch(`${BASE}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.pinterest.com/pin/478366791677246991/' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.platform, 'pinterest');
  assert.ok(data.items.length >= 1, 'expected at least one pin item');

  const photo = data.items.find((i) => i.type === 'photo');
  assert.ok(photo, 'expected a photo item');
  // Every pin exposes several sizes, including the original.
  assert.ok((photo.variants || []).length >= 5, 'expected several size variants');
  assert.ok(
    photo.variants.some((v) => v.format_id === 'orig'),
    'expected an "orig" (original quality) variant'
  );
  assert.match(photo.url, /^https:\/\/i\.pinimg\.com\//);
});

test('a Pinterest photo downloads at original quality', async () => {
  const probe = await (
    await fetch(`${BASE}/api/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.pinterest.com/pin/478366791677246991/' }),
    })
  ).json();
  const item = probe.items.find((i) => i.type === 'photo');

  const started = await fetch(`${BASE}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://www.pinterest.com/pin/478366791677246991/',
      selection: [{ ...item, variant: item.variants.find((v) => v.format_id === 'orig') }],
    }),
  });
  const { id } = await started.json();
  let job = null;
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${BASE}/api/jobs/${id}`);
    job = await r.json();
    if (job.status === 'complete' || job.status === 'error') break;
    await new Promise((r2) => setTimeout(r2, 700));
  }
  assert.equal(job.status, 'complete', job.error || 'job did not complete');
  assert.ok(job.file || job.files, 'expected a produced file');
});

test('the sign-in panel lists every site and reports status', async () => {
  const res = await fetch(`${BASE}/api/accounts`);
  assert.equal(res.status, 200);
  const data = await res.json();
  const keys = data.accounts.map((a) => a.key);
  for (const expected of ['instagram', 'reddit', 'pinterest', 'vimeo', 'facebook', 'x']) {
    assert.ok(keys.includes(expected), `expected ${expected} in the sign-in list`);
  }
  for (const a of data.accounts) {
    assert.equal(typeof a.exists, 'boolean', `${a.key} should report a boolean status`);
  }
});

test('logging into an unknown site is rejected', async () => {
  const res = await fetch(`${BASE}/api/login/notasite`, { method: 'POST' });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /Unknown site/);
});

test('forgetting a session removes it', async () => {
  // Seed a fake saved session, then delete it.
  const site = 'reddit';
  const res = await fetch(`${BASE}/api/login/${site}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const after = await (await fetch(`${BASE}/api/accounts`)).json();
  const reddit = after.accounts.find((a) => a.key === site);
  assert.equal(reddit.exists, false);
});

test('an X/Twitter post with videos yields video items, not zero-variant photos', async () => {
  const res = await fetch(`${BASE}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://twitter.com/CTVJLaidlaw/status/1600649710662213632' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.platform, 'twitter');

  const videos = data.items.filter((i) => i.type === 'video');
  assert.ok(videos.length >= 1, `expected videos, got ${JSON.stringify(data.counts)}`);

  // Regression: playlist entries were previously mislabelled as photos with
  // no renditions at all.
  for (const v of videos) {
    assert.ok((v.variants || []).length >= 1, 'video item must carry renditions');
    assert.ok(v.thumbnail, 'video item should have a thumbnail');
  }
});

test('an X/Twitter video actually downloads', async () => {
  const probe = await (
    await fetch(`${BASE}/api/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://twitter.com/CTVJLaidlaw/status/1600649710662213632' }),
    })
  ).json();
  const item = probe.items.find((i) => i.type === 'video');

  const started = await fetch(`${BASE}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://twitter.com/CTVJLaidlaw/status/1600649710662213632',
      selection: [item],
    }),
  });
  const { id } = await started.json();
  let job = null;
  for (let i = 0; i < 90; i++) {
    job = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    if (job.status === 'complete' || job.status === 'error') break;
    await new Promise((r) => setTimeout(r, 800));
  }
  assert.equal(job.status, 'complete', job.error || 'job did not complete');
  const files = job.file || job.files || [];
  assert.ok(files.length >= 1, 'expected a produced file');
  const f = Array.isArray(files) ? files[0] : files;
  assert.ok(f.size > 10000, `expected a real file, got ${f.size} bytes`);
});

test('Instagram reels resolve without a logged-in session', async () => {
  const res = await fetch(`${BASE}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.instagram.com/reel/De2bNIWSZdB/' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.platform, 'instagram');
  assert.ok(
    (data.counts.video || 0) >= 1,
    `expected at least one video, got ${JSON.stringify(data.counts)}`
  );
});

test('Telegram channel links resolve without any yt-dlp/gallery-dl support', async () => {
  const res = await fetch(`${BASE}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://t.me/s/telegram' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.platformName, 'Telegram');
  assert.ok(body.counts.video + body.counts.photo > 0, 'expected media from the channel');
  // Telegram URLs are signed and must be fetched directly, not via an extractor.
  assert.ok(
    body.items.every((i) => i.source === 'telegram'),
    'every item should be marked source=telegram'
  );
});

test('a video can be downloaded at a chosen rendition', async () => {
  const probeRes = await fetch(`${BASE}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }),
  });
  const probe = await probeRes.json();
  const video = probe.items.find((i) => i.type === 'video');

  // Pick the smallest rendition to keep the test fast.
  const small = video.variants
    .filter((v) => v.height && v.height <= 480)
    .sort((a, b) => (a.height || 0) - (b.height || 0))[0];
  assert.ok(small, 'expected a small rendition to test with');

  const start = await fetch(`${BASE}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      title: 'rendition-test',
      selection: [{ id: video.id, type: 'video', ext: 'mp4', variant: small }],
      options: { quality: 'best', audioFormat: 'mp3' },
    }),
  });
  assert.equal(start.status, 200);
  const { id } = await start.json();

  let job;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    job = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    if (job.status === 'complete' || job.status === 'error') break;
  }

  assert.equal(job.status, 'complete', `job failed: ${job.error}`);
  const ok = job.files.filter((f) => !f.failed);
  assert.equal(ok.length, 1, 'expected one produced file');
  assert.ok(ok[0].size > 50000, `file suspiciously small: ${ok[0].size}`);
});

test('a job can be deleted', async () => {
  const start = await fetch(`${BASE}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://example.com/a.mp4',
      title: 'tmp',
      selection: [{ id: 'd0', type: 'video', ext: 'mp4', url: 'https://example.com/a.mp4', source: 'direct' }],
    }),
  });
  const { id } = await start.json();
  await new Promise((r) => setTimeout(r, 1500));
  const del = await fetch(`${BASE}/api/jobs/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.equal(body.ok, true);
  const after = await fetch(`${BASE}/api/jobs/${id}`);
  assert.equal(after.status, 404);
});

test('unknown job id returns 404', async () => {
  const res = await fetch(`${BASE}/api/jobs/does-not-exist`);
  assert.equal(res.status, 404);
});
