/**
 * Platform detection from a URL. Platform keys map to display metadata
 * used by the frontend for badges and icons.
 */
export const PLATFORMS = {
  youtube: { name: 'YouTube', color: '#ff0033', hosts: ['youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com'] },
  instagram: { name: 'Instagram', color: '#e1306c', hosts: ['instagram.com', 'instagr.am', 'ddinstagram.com'] },
  tiktok: { name: 'TikTok', color: '#25f4ee', hosts: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'] },
  twitter: { name: 'X / Twitter', color: '#1d9bf0', hosts: ['twitter.com', 'x.com', 'mobile.twitter.com'] },
  facebook: { name: 'Facebook', color: '#1877f2', hosts: ['facebook.com', 'fb.watch', 'm.facebook.com'] },
  reddit: { name: 'Reddit', color: '#ff4500', hosts: ['reddit.com', 'redd.it', 'i.reddit.com', 'old.reddit.com'] },
  pinterest: { name: 'Pinterest', color: '#bd081c', hosts: ['pinterest.com', 'pin.it', 'pinterest.co.uk'] },
  soundcloud: { name: 'SoundCloud', color: '#ff5500', hosts: ['soundcloud.com', 'snd.sc'] },
  spotify: { name: 'Spotify', color: '#1db954', hosts: ['open.spotify.com', 'spotify.link'] },
  tumblr: { name: 'Tumblr', color: '#36465d', hosts: ['tumblr.com'] },
  vk: { name: 'VK', color: '#0077ff', hosts: ['vk.com', 'vkvideo.ru'] },
  bbc: { name: 'BBC', color: '#bb1919', hosts: ['bbc.co.uk'] },
  dailymotion: { name: 'Dailymotion', color: '#0066dc', hosts: ['dailymotion.com', 'dai.ly'] },
  vimeo: { name: 'Vimeo', color: '#1ab7ea', hosts: ['vimeo.com'] },
  twitch: { name: 'Twitch', color: '#9146ff', hosts: ['twitch.tv', 'clips.twitch.tv'] },
  threads: { name: 'Threads', color: '#8a8a8a', hosts: ['threads.net', 'threads.com'] },
  telegram: { name: 'Telegram', color: '#2aabee', hosts: ['t.me', 'telegram.me'] },
  flickr: { name: 'Flickr', color: '#ff0084', hosts: ['flickr.com', 'flic.kr'] },
  deviantart: { name: 'DeviantArt', color: '#05cc47', hosts: ['deviantart.com', 'fav.me'] },
  imgur: { name: 'Imgur', color: '#1bb76e', hosts: ['imgur.com', 'i.imgur.com'] },
  ttw: { name: 'TikTok (TTW)', color: '#25f4ee', hosts: ['tiktok.com'] },
  bili: { name: 'Bilibili', color: '#00a1d6', hosts: ['bilibili.com', 'b23.tv'] },
  weibo: { name: 'Weibo', color: '#e6162d', hosts: ['weibo.com', 'weibo.cn'] },
  file: { name: 'Direct file', color: '#64748b', hosts: [] },
};

const EXT_RE = /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|wav|flac|ogg|opus|jpe?g|png|gif|webp|avif|bmp|heic|zip|pdf)(?:\?|#|$)/i;

export function detectPlatform(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (EXT_RE.test(u.pathname)) return 'file';
  for (const [key, p] of Object.entries(PLATFORMS)) {
    if (!p.hosts.length) continue;
    for (const h of p.hosts) {
      if (host === h || host.endsWith(`.${h}`)) return key;
    }
  }
  return null;
}

export function platformMeta(key) {
  return PLATFORMS[key] || { name: key || 'Unknown', color: '#64748b' };
}

/**
 * Known platforms that need a login cookie to expose media (Instagram gated
 * public posts, Facebook most pages, Threads, Pinterest private boards).
 */
export const COOKIE_HINT = {
  instagram: 'Instagram now gates most public posts behind a login. Add a cookies.txt for full access.',
  facebook: 'Facebook often requires a login cookie. Add a cookies.txt for full access.',
  threads: 'Threads requires a login cookie.',
  pinterest: 'Pinterest may require a login cookie.',
  reddit: 'Reddit frequently blocks datacenter IPs. A cookie may help.',
};
