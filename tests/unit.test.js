import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, platformMeta } from '../server/lib/platforms.js';
import { isDirectFile, probeDirectFile } from '../server/lib/extract.js';

test('detects platforms from real URLs', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'youtube'],
    ['https://youtu.be/aqz-KE-bpKQ', 'youtube'],
    ['https://www.instagram.com/reel/C5NoGwHkbKl/', 'instagram'],
    ['https://instagram.com/p/CUbHfhpswxt/', 'instagram'],
    ['https://www.tiktok.com/@user/video/123', 'tiktok'],
    ['https://x.com/user/status/123', 'twitter'],
    ['https://twitter.com/user/status/123', 'twitter'],
    ['https://www.reddit.com/r/pics/comments/abc/', 'reddit'],
    ['https://soundcloud.com/artist/track', 'soundcloud'],
    ['https://www.facebook.com/watch/?v=123', 'facebook'],
    ['https://vm.tiktok.com/ZMxxxx/', 'tiktok'],
    ['https://www.tumblr.com/post/123', 'tumblr'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(detectPlatform(url), expected, `expected ${expected} for ${url}`);
  }
});

test('detects direct media files', () => {
  assert.equal(detectPlatform('https://example.com/a.mp4'), 'file');
  assert.equal(detectPlatform('https://example.com/a.jpg'), 'file');
  assert.equal(detectPlatform('https://example.com/a.mp3'), 'file');
  assert.equal(detectPlatform('https://example.com/page'), null);
});

test('direct file detection respects query strings', () => {
  assert.equal(isDirectFile('https://cdn.example.com/photo.jpg?width=800'), true);
  assert.equal(isDirectFile('https://example.com/watch?v=abc'), false);
});

test('probeDirectFile classifies by extension', () => {
  const img = probeDirectFile('https://example.com/pic.png');
  assert.equal(img.counts.photo, 1);
  assert.equal(img.counts.video, 0);

  const vid = probeDirectFile('https://example.com/clip.mp4');
  assert.equal(vid.counts.video, 1);

  const aud = probeDirectFile('https://example.com/song.mp3');
  assert.equal(aud.counts.audio, 1);
  assert.equal(aud.items[0].type, 'audio');
});

test('platform metadata is present for every detected key', () => {
  for (const key of ['youtube', 'instagram', 'tiktok', 'twitter', 'file']) {
    const meta = platformMeta(key);
    assert.ok(meta.name, `missing name for ${key}`);
    assert.ok(meta.color.startsWith('#'), `bad color for ${key}`);
  }
});

test('safeName produces header-safe ASCII file names', async () => {
  const { safeName } = await import('../server/lib/jobs.js');
  // Non-Latin and emoji names used to crash Node with ERR_INVALID_CHAR when
  // they reached a Content-Disposition header.
  for (const input of ['日本語のタイトル_01.mp4', 'emoji_😀_01.jpg', 'Видео_01.mp4', 'café_01.jpg']) {
    const out = safeName(input);
    assert.match(out, /^[\x20-\x7e]+$/, `${input} -> ${out} must be printable ASCII`);
    assert.ok(out.length > 0);
  }
  assert.equal(safeName('   '), 'media');
  assert.equal(safeName('a/b\c:d*e?f"g<h>i|j'), 'abcdefghij');
});

test('contentDisposition never throws for any filename', async () => {
  const { contentDisposition } = await import('../server/lib/jobs.js');
  const http = await import('node:http');
  const cases = ['kaigakure_01.jpg', '日本語_01.jpg', 'emoji_😀_01.jpg', 'line\nbreak.jpg', 'a"b_01.jpg', ''];
  for (const name of cases) {
    const value = contentDisposition(name);
    assert.ok(value.startsWith('attachment'));
    // The whole point: this must not throw.
    const res = new http.ServerResponse({ method: 'GET' });
    res.setHeader('Content-Disposition', value);
  }
});

test('parseBatchUrls normalises, dedupes and caps the list', async () => {
  const { parseBatchUrls, BATCH_LIMIT } = await import('../server/lib/batch.js');
  // Accepts a pasted blob: newlines, commas and semicolons all split.
  const fromText = parseBatchUrls('https://a.com/1\nhttps://b.com/2,https://c.com/3;https://a.com/1');
  assert.equal(fromText.length, 3, 'duplicates removed');

  // Accepts an array too.
  assert.equal(parseBatchUrls(['https://x.com/1', 'https://x.com/1']).length, 1);

  // Adds https:// when the scheme is missing.
  assert.equal(parseBatchUrls(['example.com/post'])[0], 'https://example.com/post');

  // Drops junk.
  assert.deepEqual(parseBatchUrls(['not a url', '', '   ', 'http://']), []);

  // Caps at BATCH_LIMIT.
  const many = Array.from({ length: BATCH_LIMIT + 15 }, (_, i) => `https://s${i}.com/p`);
  assert.equal(parseBatchUrls(many).length, BATCH_LIMIT);
});

test('normalizeUrl rejects hosts without a dot', async () => {
  const { normalizeUrl } = await import('../server/lib/batch.js');
  assert.equal(normalizeUrl('http://localhost/x'), null);
  assert.equal(normalizeUrl('http://127.0.0.1/x'), 'http://127.0.0.1/x');
});

test('HTML has no duplicate element ids', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const html = readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate ids found: ${[...new Set(dupes)].join(', ')}`);
});
