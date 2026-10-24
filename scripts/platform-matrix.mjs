/**
 * Real-world platform probe matrix. Runs each URL through the live server's
 * /api/probe and reports what it actually found, so the support matrix in the
 * README is measured rather than assumed.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

const CASES = [
  ['YouTube', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'],
  ['YouTube short', 'https://www.youtube.com/shorts/9bZkp7q19f0'],
  ['YouTube playlist', 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'],
  ['SoundCloud', 'https://soundcloud.com/forss/flickermood'],
  ['TikTok', 'https://www.tiktok.com/@scout2015/video/6718335390845095173'],
  ['X/Twitter', 'https://twitter.com/jack/status/20'],
  ['Instagram reel', 'https://www.instagram.com/reel/C5NoGwHkbKl/'],
  ['Reddit', 'https://www.reddit.com/r/videos/comments/1c0hvr3/'],
  ['Pinterest pin', 'https://www.pinterest.com/pin/86772054525037948/'],
  ['Facebook video', 'https://www.facebook.com/watch/?v=1015895329'],
  ['Vimeo', 'https://vimeo.com/76979871'],
  ['Dailymotion', 'https://www.dailymotion.com/video/x8pdxbz'],
  ['Tumblr', 'https://www.tumblr.com/staff/71234567890'],
  ['Imgur album', 'https://imgur.com/a/0azvj'],
  ['Imgur image', 'https://i.imgur.com/abc123.jpg'],
  ['Telegram channel', 'https://t.me/s/telegram'],
  ['Telegram post', 'https://t.me/telegram/441'],
  ['VK video', 'https://vk.com/video-22822305_456240426'],
  ['Bilibili', 'https://www.bilibili.com/video/BV1GJ411x7h7'],
  ['Weibo', 'https://m.weibo.cn/status/5001326070791333'],
  ['Twitch clip', 'https://www.twitch.tv/videos/123456789'],
  ['Spotify track', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'],
  ['Direct mp4', 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4'],
  ['Direct png', 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png'],
  ['Direct mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'],
];

async function probe(url) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    return { status: res.status, data, ms: Date.now() - started };
  } catch (err) {
    return { status: 'ERR', data: { error: String(err) }, ms: Date.now() - started };
  }
}

const rows = [];
for (const [name, url] of CASES) {
  const { status, data, ms } = await probe(url);
  let verdict, detail = '';
  if (status === 200) {
    const c = data.counts || {};
    const items = data.items || [];
    const rend = items.find((i) => i.type === 'video')?.variants?.length || 0;
    verdict = 'OK';
    detail = `v${c.video} a${c.audio} p${c.photo}` + (rend ? ` (${rend} renditions)` : '');
  } else {
    verdict = 'FAIL';
    detail = (data.error || '').slice(0, 80);
  }
  rows.push({ name, verdict, ms, detail });
  console.log(`${verdict.padEnd(4)} ${String(ms).padStart(6)}ms  ${name.padEnd(18)} ${detail}`);
}

const ok = rows.filter((r) => r.verdict === 'OK').length;
console.log(`\n${ok}/${rows.length} probed successfully`);
