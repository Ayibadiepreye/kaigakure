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
