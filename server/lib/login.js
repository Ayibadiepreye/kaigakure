import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_DIR = path.join(__dirname, '..', '..', 'data', 'accounts');
const BROWSER_DIR = path.join(__dirname, '..', '..', 'data', 'browser-profile');

for (const d of [ACCOUNTS_DIR, BROWSER_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

/**
 * Sites Kaigakure can log into, mapped to the domain the cookies belong to.
 * `startUrl` is where the login window opens; `home` is where it lands once
 * signed in (used to decide when the user is done).
 */
export const SITES = {
  instagram: {
    label: 'Instagram',
    domain: '.instagram.com',
    startUrl: 'https://www.instagram.com/accounts/login/',
    home: 'https://www.instagram.com/',
    file: 'instagram.cookies.txt',
  },
  reddit: {
    label: 'Reddit',
    domain: '.reddit.com',
    startUrl: 'https://www.reddit.com/login/',
    home: 'https://www.reddit.com/',
    file: 'reddit.cookies.txt',
  },
  pinterest: {
    label: 'Pinterest',
    domain: '.pinterest.com',
    startUrl: 'https://www.pinterest.com/login/',
    home: 'https://www.pinterest.com/',
    file: 'pinterest.cookies.txt',
  },
  vimeo: {
    label: 'Vimeo',
    domain: '.vimeo.com',
    startUrl: 'https://vimeo.com/log_in',
    home: 'https://vimeo.com/',
    file: 'vimeo.cookies.txt',
  },
  facebook: {
    label: 'Facebook',
    domain: '.facebook.com',
    startUrl: 'https://www.facebook.com/login/',
    home: 'https://www.facebook.com/',
    file: 'facebook.cookies.txt',
  },
  x: {
    label: 'X (Twitter)',
    domain: '.x.com',
    startUrl: 'https://x.com/i/flow/login',
    home: 'https://x.com/home',
    file: 'x.cookies.txt',
  },
};

/** Which cookie files exist right now, and roughly how good they look. */
export function listAccounts() {
  const out = [];
  for (const [key, site] of Object.entries(SITES)) {
    const file = path.join(ACCOUNTS_DIR, site.file);
    let exists = false;
    let bytes = 0;
    let domains = 0;
    try {
      const st = fs.statSync(file);
      exists = true;
      bytes = st.size;
      domains = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l && !l.startsWith('#')).length;
    } catch {
      /* not saved yet */
    }
    out.push({ key, label: site.label, exists, bytes, domains });
  }
  return out;
}

export function accountFile(key) {
  const site = SITES[key];
  if (!site) return null;
  return path.join(ACCOUNTS_DIR, site.file);
}

export function accountExists(key) {
  const f = accountFile(key);
  if (!f) return false;
  try {
    return fs.statSync(f).size > 40;
  } catch {
    return false;
  }
}

/** Delete a saved session. */
export function forgetAccount(key) {
  const f = accountFile(key);
  if (!f) return false;
  try {
    fs.unlinkSync(f);
    return true;
  } catch {
    return false;
  }
}

/** Write a Playwright cookie array to a Netscape cookies.txt file. */
export function writeNetscape(cookies, outPath) {
  const header = '# Netscape HTTP Cookie File\n# Saved by Kaigakure. Local only.\n\n';
  const lines = cookies.map((c) => {
    const domain = c.domain || '';
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires = c.expires && c.expires > 0 ? String(Math.floor(c.expires)) : '0';
    const name = c.name || '';
    const value = c.value || '';
    return [domain, includeSub, c.path || '/', secure, expires, name, value].join('\t');
  });
  fs.writeFileSync(outPath, header + lines.join('\n') + '\n', { mode: 0o600 });
  return lines.length;
}

/** Merge every saved session into one cookies.txt for yt-dlp. */
export function refreshMerged() {
  const merged = path.join(__dirname, '..', '..', 'data', 'cookies.txt');
  const parts = ['# Netscape HTTP Cookie File\n# Merged from saved Kaigakure sessions.\n'];
  let total = 0;
  for (const site of Object.values(SITES)) {
    const f = path.join(ACCOUNTS_DIR, site.file);
    try {
      const body = fs.readFileSync(f, 'utf8');
      const lines = body.split('\n').filter((l) => l && !l.startsWith('#'));
      if (lines.length) {
        parts.push(`\n# --- ${site.label} ---`);
        parts.push(...lines);
        total += lines.length;
      }
    } catch {
      /* not saved */
    }
  }
  if (total === 0) {
    try {
      fs.unlinkSync(merged);
    } catch {
      /* nothing to remove */
    }
    return { merged: false, cookies: 0 };
  }
  fs.writeFileSync(merged, parts.join('\n') + '\n', { mode: 0o600 });
  return { merged: true, cookies: total };
}

/**
 * Run an interactive login in a real browser window.
 *
 * The user types their own credentials into the site's own page. Kaigakure
 * never sees a password — it only reads the session cookies the site sets
 * afterwards. The window stays open until the user closes it or clicks
 * "I've finished".
 */
export async function loginSite(key, { headless = false } = {}) {
  const site = SITES[key];
  if (!site) throw new Error(`Unknown site: ${key}`);

  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(BROWSER_DIR, {
    headless,
    viewport: { width: 480, height: 860 },
    acceptDownloads: false,
    locale: 'en-US',
  });

  const page = context.pages()[0] || (await context.newPage());

  await page.goto(site.startUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

  // Poll until the site signs us in, or the window closes.
  let signedIn = false;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const open = context.pages().length > 0 && !page.isClosed();
    if (!open) break;
    try {
      const url = page.url();
      const cookies = await context.cookies();
      // A session cookie means we're in.
      const hasSession = cookies.some(
        (c) => /session|auth|token|sid|logged/i.test(c.name) && c.value && c.value.length > 4
      );
      const atHome = url.startsWith(site.home.replace(/\/$/, '')) && !/login|log_in|signin|auth/i.test(url);
      if (hasSession || atHome) {
        signedIn = true;
        break;
      }
    } catch {
      /* page may be navigating */
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  const cookies = signedIn ? await context.cookies().catch(() => []) : [];
  await context.close().catch(() => {});

  if (!signedIn || !cookies.length) {
    const e = new Error('No signed-in session was detected.');
    e.userFacing =
      "Kaigakure didn't detect a login. Complete the login in the window, then try again.";
    throw e;
  }

  const n = writeNetscape(cookies, accountFile(key));
  refreshMerged();
  return { key, label: site.label, cookies: n, domains: [...new Set(cookies.map((c) => c.domain))] };
}

/** Save cookies pasted by hand (the existing flow), still merged. */
export function savePasted(cookies) {
  const merged = path.join(__dirname, '..', '..', 'data', 'cookies.txt');
  fs.writeFileSync(merged, cookies, { mode: 0o600 });
  return cookies.length;
}
