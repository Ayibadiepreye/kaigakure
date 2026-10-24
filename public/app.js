import {
  isSaveFolderSupported,
  getSaveFolder,
  pickSaveFolder,
  saveToFolder,
  saveZipToFolder,
} from './savefolder.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  url: '',
  probe: null,
  selected: new Set(),
  quality: 'best',
  audioFormat: 'mp3',
  mode: 'all',
  jobId: null,
  pollTimer: null,
  history: JSON.parse(localStorage.getItem('kg_history') || '[]'),
};

const DEMOS = {
  youtube: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  soundcloud: 'https://soundcloud.com/forss/flickermood',
  tiktok: 'https://www.tiktok.com/@scout2015/video/6718335390845095173',
  instagram: 'https://www.instagram.com/reel/C5NoGwHkbKl/',
  telegram: 'https://t.me/s/telegram',
};

const fmtBytes = (n) => {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
};
const fmtDur = (s) => {
  if (!s && s !== 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

/* ---------------- helpers ---------------- */
function show(el, on = true) { el.hidden = !on; }
function setBusy(form, on) {
  $('#btnGo').disabled = on;
  $('#btnGo').textContent = on ? 'Reading…' : 'Reveal';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** Proxied image URL so CDNs that check Referer/CORS still serve us. */
function proxied(url) {
  return `/api/image?url=${encodeURIComponent(url)}&source=${encodeURIComponent(state.url)}`;
}

/* ---------------- probe ---------------- */
async function doProbe(url) {
  const clean = url.trim();
  if (!clean) return;
  state.url = clean;
  $('#url').value = clean;
  show($('#errorBox'), false);
  show($('#result'), false);
  show($('#done'), false);
  show($('#progress'), true);
  $('#pLabel').textContent = 'Reading link…';
  $('#pDetail').textContent = 'Looking for every photo, video and audio track.';
  $('#pBar').style.width = '12%';
  setBusy($('#form'), true);

  try {
    const res = await fetch('/api/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: clean }),
    });
    const data = await res.json();
    show($('#progress'), false);

    if (!res.ok) {
      showError(data.error || 'Could not read that link.', data.platformName);
      setBusy($('#form'), false);
      return;
    }

    // A post that simply has no media: explain it, don't scold.
    if (data.empty) {
      showEmpty(data.empty, data.platformName);
      setBusy($('#form'), false);
      return;
    }

    state.probe = data;
    state.selected = new Set();
    renderProbe(data);
    saveHistory(clean, data.platformName);
    setBusy($('#form'), false);
  } catch (err) {
    show($('#progress'), false);
    showError(String(err.message || err));
    setBusy($('#form'), false);
  }
}

function showError(msg, platformName) {
  const box = $('#errorBox');
  const needsAuth =
    /authentication|logged-in|login required|login-required|account credentials/i.test(msg);
  const hint = needsAuth
    ? `<p class="hint">That platform only serves media to signed-in sessions. Open the
       <strong>Sign in</strong> button and log in to unlock it.</p>`
    : '';
  box.innerHTML = `<h3>Could not read that link</h3><p>${escapeHtml(msg)}</p>${hint}${
    platformName ? `<p class="plat">Detected platform: ${escapeHtml(platformName)}</p>` : ''
  }`;
  show(box, true);
}

/** A post that exists but carries no media. Not an error. */
function showEmpty(msg, platformName) {
  const box = $('#errorBox');
  box.innerHTML = `<h3>Nothing to download here</h3>
    <p>This post doesn't carry any photo, video or audio that Kaigakure can read.</p>
    ${msg ? `<p class="hint">${escapeHtml(msg)}</p>` : ''}
    <p class="hint">If the post looks like it has media, it may be private, or the platform
    may have changed. Try another post, or sign in via the <strong>Sign in</strong> button.</p>
    ${platformName ? `<p class="plat">Detected platform: ${escapeHtml(platformName)}</p>` : ''}`;
  show(box, true);
}

/* ---------------- render ---------------- */
function renderProbe(data) {
  const badge = $('#platformBadge');
  badge.textContent = data.platformName || 'Unknown';
  if (data.platformColor) {
    badge.style.background = `${data.platformColor}26`;
    badge.style.color = data.platformColor;
    badge.style.borderColor = `${data.platformColor}55`;
  } else {
    badge.style.background = '';
    badge.style.color = '';
    badge.style.borderColor = '';
  }

  $('#title').textContent = data.title || 'Untitled';
  const bits = [];
  if (data.author) bits.push(data.author);
  if (data.duration) bits.push(fmtDur(data.duration));
  if (data.counts) {
    const parts = [];
    if (data.counts.video) parts.push(`${data.counts.video} video`);
    if (data.counts.audio) parts.push(`${data.counts.audio} audio`);
    if (data.counts.photo) parts.push(`${data.counts.photo} photo`);
    if (parts.length) bits.push(parts.join(' · '));
  }
  $('#submeta').textContent = bits.join('   ');

  const warn = $('#cookieWarn');
  if (data.cookieHint) {
    warn.innerHTML = `${escapeHtml(data.cookieHint)}
      <button id="warnCookies" class="linkbtn" type="button">Add cookies</button>`;
    warn.hidden = false;
    $('#warnCookies').addEventListener('click', () => $('#btnCookies').click());
  } else {
    warn.hidden = true;
  }

  applyMode();
  show($('#result'), true);
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function visibleItems() {
  const data = state.probe;
  if (!data) return [];
  const m = state.mode;
  return data.items.filter((it) => {
    if (m === 'photos') return it.type === 'photo';
    if (m === 'videos') return it.type === 'video';
    if (m === 'audio') return it.type === 'audio';
    return true;
  });
}

/** Human label for a rendition, e.g. "1080p · mp4 · 60fps". */
function variantLabel(v) {
  const parts = [];
  if (v.height) parts.push(`${v.height}p`);
  if (v.ext) parts.push(v.ext);
  if (v.fps && v.fps > 30) parts.push(`${v.fps}fps`);
  if (v.abr) parts.push(`${Math.round(v.abr)} kbps`);
  return parts.join(' · ') || 'original';
}

function applyMode() {
  const data = state.probe;
  if (!data) return;
  const grid = $('#grid');
  grid.innerHTML = '';

  const shown = visibleItems();
  if (!shown.length) {
    grid.innerHTML = `<p class="muted empty">Nothing of that type in this link. Switch back to “Everything”.</p>`;
    updateSelCount();
    return;
  }

  for (const it of shown) {
    const card = document.createElement('div');
    const sel = state.selected.has(it.id);
    card.className = 'card' + (sel ? ' sel' : '');
    card.dataset.id = it.id;

    // ---- thumbnail ----
    let thumbHtml = '';
    if (it.type === 'photo' && it.url) {
      thumbHtml = `<img src="${proxied(it.url)}" alt="" loading="lazy" onerror="this.style.display='none'">`;
    } else if (it.type === 'video') {
      const t = it.thumbnail
        ? `<img src="${proxied(it.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : '';
      thumbHtml = `${t}<div class="playbadge"><span><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span></div>`;
    } else if (it.type === 'audio') {
      const t = it.thumbnail
        ? `<img src="${proxied(it.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : '';
      const bars = Array.from({ length: 24 }, (_, i) => {
        const h = 16 + Math.round(26 * Math.abs(Math.sin(i * 0.85)));
        return `<i style="height:${h}px"></i>`;
      }).join('');
      thumbHtml = `${t}<div class="audiowave">${bars}</div>`;
    }

    // ---- rendition picker (video/audio with more than one option) ----
    const variants = it.variants || [];
    let pickerHtml = '';
    if (variants.length > 1) {
      const options = variants
        .map((v, i) => `<option value="${i}">${escapeHtml(variantLabel(v))}</option>`)
        .join('');
      pickerHtml = `<select class="variantpick" data-id="${it.id}" aria-label="Quality">${options}</select>`;
    } else if (variants.length === 1) {
      pickerHtml = `<span class="variantstatic">${escapeHtml(variantLabel(variants[0]))}</span>`;
    }

    const metaLine =
      it.type === 'photo'
        ? [it.width && it.height ? `${it.width}×${it.height}` : '', it.ext].filter(Boolean).join(' · ')
        : [fmtDur(it.duration), it.ext].filter(Boolean).join(' · ');

    card.innerHTML = `
      <div class="thumb">
        <span class="typebadge ${it.type}">${it.type}</span>
        ${thumbHtml}
        <span class="check"><svg viewBox="0 0 24 24"><polyline points="4 12 10 18 20 6"/></svg></span>
      </div>
      <div class="meta2">
        <strong>${escapeHtml(it.title || it.type)}</strong>
        <span class="sub">${escapeHtml(metaLine)}</span>
        ${pickerHtml}
        <div class="cardactions">
          <button class="btn-primary btn-sm carddl" data-id="${it.id}" type="button">download</button>
        </div>
      </div>`;

    card.addEventListener('click', (e) => {
      // Clicking the quality picker or the download button must not toggle the card.
      if (e.target.closest('.variantpick')) return;
      if (e.target.closest('.carddl')) return;
      toggle(it.id, card);
    });

    const picker = card.querySelector('.variantpick');
    if (picker) {
      picker.addEventListener('change', () => {
        it.chosenVariant = variants[Number(picker.value)] || null;
      });
    }

    // Per-card download: grab just this one item.
    const dl = card.querySelector('.carddl');
    if (dl) {
      dl.addEventListener('click', () => {
        it.chosenVariant = picker ? variants[Number(picker.value)] || null : it.chosenVariant;
        downloadSingle(it);
      });
    }

    grid.appendChild(card);
  }
  updateSelCount();
}

/** Download one item straight away, without the select-all flow. */
async function downloadSingle(item) {
  if (!state.probe) return;
  const selection = [{
    id: item.id,
    type: item.type,
    ext: item.ext,
    url: item.url,
    source: item.source,
    title: item.title,
    variant: item.chosenVariant || null,
  }];

  show($('#result'), false);
  show($('#done'), false);
  show($('#progress'), true);
  $('#pLabel').textContent = 'Downloading…';
  $('#pDetail').textContent = '1 file selected.';
  $('#pBar').style.width = '5%';

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: state.url,
        selection,
        title: (state.probe.title || 'kaigakure').slice(0, 60),
        options: { quality: state.quality, audioFormat: state.audioFormat },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Download failed');
    state.jobId = data.id;
    pollJob();
  } catch (err) {
    show($('#progress'), false);
    showError(String(err.message || err));
  }
}

function toggle(id, card) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  card.classList.toggle('sel', state.selected.has(id));
  updateSelCount();
}

function updateSelCount() {
  const n = state.selected.size;
  $('#selCount').textContent = `${n} selected`;
  $('#btnDownload').disabled = n === 0;
  $('#btnZip').disabled = n === 0;
}

/* ---------------- download ---------------- */
async function startDownload() {
  if (!state.selected.size || !state.probe) return;
  const items = state.probe.items.filter((i) => state.selected.has(i.id));
  const selection = items.map((i) => ({
    id: i.id,
    type: i.type,
    ext: i.ext,
    url: i.url,
    source: i.source,
    title: i.title,
    variant: i.chosenVariant || null,
  }));

  show($('#result'), false);
  show($('#done'), false);
  show($('#progress'), true);
  $('#pLabel').textContent = 'Downloading…';
  $('#pDetail').textContent = `${selection.length} file(s) selected.`;
  $('#pBar').style.width = '5%';

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: state.url,
        selection,
        title: (state.probe.title || 'kaigakure').slice(0, 60),
        options: { quality: state.quality, audioFormat: state.audioFormat },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Download failed');
    state.jobId = data.id;
    pollJob();
  } catch (err) {
    show($('#progress'), false);
    showError(String(err.message || err));
  }
}

function pollJob() {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/jobs/${state.jobId}`);
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || 'Job lost');

      const pct = job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 10;
      $('#pBar').style.width = `${Math.max(5, pct)}%`;
      $('#pLabel').textContent = job.status === 'complete' ? 'Complete' : 'Downloading…';
      $('#pDetail').textContent = job.progress.label || '';

      if (job.status === 'complete') {
        show($('#progress'), false);
        renderFiles(job);
        return;
      }
      if (job.status === 'error') {
        show($('#progress'), false);
        showError(job.error || 'Download failed');
        return;
      }
      pollJob();
    } catch (err) {
      show($('#progress'), false);
      showError(String(err.message || err));
    }
  }, 600);
}

function renderFiles(job) {
  const list = $('#fileList');
  list.innerHTML = '';
  for (const f of job.files) {
    const li = document.createElement('li');
    if (f.failed) li.className = 'failed';
    li.innerHTML = `<span class="nm">${escapeHtml(f.name)}${f.failed ? ' — failed' : ''}</span>
      <span class="sz">${f.failed ? escapeHtml(f.error || '') : fmtBytes(f.size)}</span>`;
    if (!f.failed) {
      // Per-file download button. Written as a <button> so it can call the
      // folder-aware path; a plain link would ignore the chosen folder.
      const a = document.createElement('button');
      a.type = 'button';
      a.className = 'sz save';
      a.textContent = 'download';
      a.title = `Download ${f.name}`;
      a.addEventListener('click', () => saveOne(job.id, f.name));
      li.querySelector('.sz').replaceWith(a);
    }
    list.appendChild(li);
  }
  const failed = job.files.filter((f) => f.failed).length;
  $('#doneTitle').textContent = failed
    ? `Done — ${failed} of ${job.files.length} failed`
    : `Done — ${job.files.length} file${job.files.length === 1 ? '' : 's'}`;

  // Offer the folder feature only where the browser supports it.
  const folderBox = $('#folderBox');
  if (folderBox) {
    show(folderBox, SAVE_FOLDER_OK);
    renderFolderStatus();
  }

  show($('#done'), true);
  $('#done').scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Batch save: only useful where a folder can be written to.
  const all = $('#btnSaveAll');
  if (all) {
    const usable = job.files.filter((f) => !f.failed).length;
    show(all, usable > 0);
    all.textContent = `Save all to folder${usable > 1 ? ` (${usable})` : ''}`;
    all.onclick = () => saveAllToFolder(job.id, job.files);
  }
}

/* ---------------- download folder ---------------- */
let SAVE_FOLDER_OK = false;
SAVE_FOLDER_OK = isSaveFolderSupported();

async function renderFolderStatus() {
  const box = $('#folderBox');
  if (!box) return;
  if (!SAVE_FOLDER_OK) {
    box.innerHTML = `<p class="hint">This browser can't save straight into a folder — files will
      go to your normal Downloads folder.</p>`;
    return;
  }
  const dir = await getSaveFolder();
  box.innerHTML = dir
    ? `<p class="hint">Saving to <strong>${escapeHtml(dir.name)}</strong></p>
       <button id="btnChangeFolder" class="linkbtn" type="button">Change folder</button>`
    : `<p class="hint">Pick a folder once and every download lands there — no Save As each time.</p>
       <button id="btnPickFolder" class="btn-primary btn-sm" type="button">Choose download folder</button>`;

  const pick = $('#btnPickFolder');
  if (pick) {
    pick.addEventListener('click', async () => {
      try {
        await pickSaveFolder();
        renderFolderStatus();
      } catch (err) {
        if (err?.name !== 'AbortError') showError(String(err.message || err));
      }
    });
  }
  const change = $('#btnChangeFolder');
  if (change) {
    change.addEventListener('click', async () => {
      try {
        await pickSaveFolder();
        renderFolderStatus();
      } catch (err) {
        if (err?.name !== 'AbortError') showError(String(err.message || err));
      }
    });
  }
}

/** Try to put a finished file straight into the chosen folder. */
async function saveFileToFolder(jobId, fileName) {
  try {
    const where = await saveToFolder(jobId, fileName);
    if (where) return where;
  } catch {
    /* fall through to browser download */
  }
  return null;
}

/**
 * Download one finished file. If a folder was chosen, write straight into it
 * (no Save As dialog); otherwise fall back to a normal browser download.
 */
async function saveOne(jobId, fileName) {
  if (SAVE_FOLDER_OK && (await getSaveFolder())) {
    const where = await saveFileToFolder(jobId, fileName);
    if (where) {
      setSavedNote(`Saved to ${where}`);
      return;
    }
  }
  // No folder chosen (or not supported): plain browser download.
  window.location.assign(`/api/jobs/${jobId}/file/${encodeURIComponent(fileName)}`);
}

/**
 * Save every finished file into the chosen folder, one at a time.
 *
 * Sequential on purpose: firing several downloads at once makes browsers
 * silently drop all but the last one. We fetch each file fully, then write it,
 * then move on — so nothing is lost.
 */
async function saveAllToFolder(jobId, files) {
  const btn = $('#btnSaveAll');
  const ok = files.filter((f) => !f.failed);
  if (!ok.length) return;

  const supported = SAVE_FOLDER_OK && (await getSaveFolder());
  btn.disabled = true;

  let done = 0;
  let failed = 0;

  for (const f of ok) {
    btn.textContent = `Saving ${done + 1} of ${ok.length}…`;
    try {
      const res = await fetch(`/api/jobs/${jobId}/file/${encodeURIComponent(f.name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();

      if (supported) {
        const dir = await getSaveFolder();
        const fh = await dir.getFileHandle(f.name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
      } else {
        // No folder support: trigger a real download per file, spaced out.
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        // Give the browser a beat so it does not cancel the previous download.
        await new Promise((r) => setTimeout(r, 700));
      }
      done++;
    } catch {
      failed++;
    }
  }

  btn.textContent = 'Save all to folder';
  btn.disabled = false;
  if (failed) {
    setSavedNote(`Saved ${done} of ${ok.length} — ${failed} failed.`);
  } else {
    const dir = await getSaveFolder();
    setSavedNote(`Saved ${done} file${done === 1 ? '' : 's'} to ${dir ? dir.name : 'your device'}.`);
  }
}

function setSavedNote(text) {
  const note = $('#savedNote');
  if (!note) return;
  note.textContent = text;
  show(note, true);
}

/* ---------------- history ---------------- */
function saveHistory(url, platform) {
  state.history = [{ url, platform, at: Date.now() }, ...state.history.filter((h) => h.url !== url)].slice(0, 12);
  localStorage.setItem('kg_history', JSON.stringify(state.history));
}

function openModal(title, bodyHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  show($('#modal'), true);
}
function closeModal() { show($('#modal'), false); }

/* ---------------- events ---------------- */
$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  doProbe($('#url').value);
});

$('#btnPaste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) { $('#url').value = text.trim(); $('#url').focus(); }
  } catch {
    $('#url').focus();
  }
});

$$('#chips .chip').forEach((c) =>
  c.addEventListener('click', () => { $('#url').value = DEMOS[c.dataset.demo]; doProbe(DEMOS[c.dataset.demo]); })
);

$('#quality').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.quality = b.dataset.q;
  $$('#quality button').forEach((x) => x.classList.toggle('on', x === b));
});
$('#audioFmt').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.audioFormat = b.dataset.a;
  $$('#audioFmt button').forEach((x) => x.classList.toggle('on', x === b));
});
$('#mode').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.mode = b.dataset.m;
  $$('#mode button').forEach((x) => x.classList.toggle('on', x === b));
  applyMode();
});

$('#btnAll').addEventListener('click', () => {
  visibleItems().forEach((i) => state.selected.add(i.id));
  applyMode();
});
$('#btnNone').addEventListener('click', () => {
  state.selected.clear();
  applyMode();
});

$('#btnDownload').addEventListener('click', startDownload);
$('#btnZip').addEventListener('click', startDownload);

function downloadZip() {
  if (!state.jobId) return;
  // If a folder was chosen, write straight into it instead of a Save As dialog.
  if (SAVE_FOLDER_OK) {
    saveZipToFolder(state.jobId, `kaigakure-${state.jobId.slice(0, 8)}.zip`)
      .then((where) => {
        if (where) {
          $('#zipSaved').textContent = `Saved to ${where}`;
          show($('#zipSaved'), true);
        } else {
          window.location.href = `/api/jobs/${state.jobId}/zip`;
        }
      })
      .catch(() => {
        window.location.href = `/api/jobs/${state.jobId}/zip`;
      });
    return;
  }
  window.location.href = `/api/jobs/${state.jobId}/zip`;
}
$('#btnZip2').addEventListener('click', downloadZip);

$('#btnReset').addEventListener('click', resetAll);
$('#btnAgain').addEventListener('click', resetAll);
function resetAll() {
  show($('#result'), false);
  show($('#done'), false);
  show($('#progress'), false);
  show($('#errorBox'), false);
  $('#url').value = '';
  state.probe = null;
  state.selected.clear();
  state.jobId = null;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('#btnHistory').addEventListener('click', () => {
  if (!state.history.length) { openModal('History', '<p>Nothing yet. Links you open will show up here.</p>'); return; }
  const rows = state.history.map((h) =>
    `<div class="histrow"><span>${escapeHtml(h.platform || 'link')} · ${escapeHtml(h.url.slice(0, 58))}</span>
     <button data-url="${escapeHtml(h.url)}">open</button></div>`).join('');
  openModal('History', `<div class="histlist">${rows}</div>`);
  $$('#modalBody .histrow button').forEach((b) =>
    b.addEventListener('click', () => { closeModal(); $('#url').value = b.dataset.url; doProbe(b.dataset.url); }));
});

$('#btnCookies').addEventListener('click', () => {
  openModal('Sign in', '');
  renderAccounts();
});

async function renderAccounts() {
  const body = $('#modalBody');
  body.innerHTML = `<div class="acclist" id="accList">loading…</div>`;
  let accounts = [];
  try {
    const r = await fetch('/api/accounts');
    accounts = (await r.json()).accounts || [];
  } catch {
    body.innerHTML = '<p class="hint">Could not load saved sessions.</p>';
    return;
  }

  body.innerHTML = `
    <p>Sign in once and Kaigakure keeps the session for you. <strong>Your password is typed into
    the site's own page</strong> — Kaigakure never sees it, only the session cookie afterwards.
    Nothing leaves this machine.</p>
    <div class="acclist">
      ${accounts
        .map(
          (a) => `
        <div class="accrow" data-site="${a.key}">
          <div class="accinfo">
            <strong>${escapeHtml(a.label)}</strong>
            <span class="hint">${a.exists ? `${a.domains} cookies saved` : 'not signed in'}</span>
          </div>
          <div class="accactions">
            ${
              a.exists
                ? `<button class="linkbtn" data-forget="${a.key}">sign out</button>`
                : ''
            }
            <button class="btn-primary btn-sm" data-login="${a.key}">${a.exists ? 're-login' : 'log in'}</button>
          </div>
        </div>`
        )
        .join('')}
    </div>
    <details class="pastebox">
      <summary>Paste cookies manually instead</summary>
      <div class="howto">
        <p><strong>Where to get the file</strong></p>
        <ol>
          <li>Install a cookie exporter — <strong>Cookie-Editor</strong> or <strong>Get cookies.txt LOCALLY</strong> (Chrome, Edge and Firefox all have them).</li>
          <li>Open the site you want (instagram.com, reddit.com, vimeo.com…) and <strong>sign in normally</strong> in that tab.</li>
          <li>Click the extension → <strong>Export → Export as Netscape / cookies.txt</strong>.</li>
          <li>Paste the whole block below. It looks like:<br />
            <code># Netscape HTTP Cookie File<br />
            .instagram.com&nbsp;&nbsp;TRUE&nbsp;&nbsp;/&nbsp;&nbsp;TRUE&nbsp;&nbsp;0&nbsp;&nbsp;sessionid&nbsp;&nbsp;abc123…</code></li>
        </ol>
        <p class="hint">Cookies are sent only to the site that issued them, and never leave this server.
        You can delete them at any time with <strong>forget</strong> next to the site.</p>
      </div>
      <textarea id="cookieText" placeholder="# Netscape HTTP Cookie File&#10;.instagram.com&#9;TRUE&#9;/&#9;TRUE&#9;0&#9;sessionid&#9;value"></textarea>
      <div class="actions"><button id="btnSaveCookies" class="btn-primary">Save cookies</button></div>
    </details>`;

  $$('#modalBody [data-login]').forEach((b) =>
    b.addEventListener('click', async () => {
      const site = b.dataset.login;
      b.disabled = true;
      b.textContent = 'opening…';
      const label = accounts.find((a) => a.key === site)?.label || site;
      try {
        const res = await fetch(`/api/login/${site}`, { method: 'POST' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error);
        openModal('Signed in', `
          <div class="empty">
            <div class="oktick">✓</div>
            <p><strong>${escapeHtml(d.label)}</strong> is signed in.</p>
            <p class="hint">${d.cookies} cookies saved. Retry your link now.</p>
          </div>`);
      } catch (err) {
        openModal('Sign in', `
          <div class="empty">
            <div class="errtick">!</div>
            <p>${escapeHtml(err.message)}</p>
            <p class="hint">A browser window should have opened. Complete the login there, then try again.</p>
          </div>`);
      }
    })
  );

  $$('#modalBody [data-forget]').forEach((b) =>
    b.addEventListener('click', async () => {
      await fetch(`/api/login/${b.dataset.forget}`, { method: 'DELETE' });
      renderAccounts();
    })
  );

  const save = $('#btnSaveCookies');
  if (save) {
    save.addEventListener('click', async () => {
      const cookies = $('#cookieText').value;
      try {
        const res = await fetch('/api/cookies', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error);
        renderAccounts();
      } catch (err) {
        alert('Could not save: ' + err.message);
      }
    });
  }
}

$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' || e.target.hasAttribute('data-close')) closeModal();
});

// Exposed for tests and for power users poking at the console. Harmless in
// normal use — these are the same functions the buttons call.
window.kaigakure = { saveAllToFolder, saveOne, downloadSingle };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/* ---------------- PWA ---------------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('#btnPwa').hidden = false;
});
$('#btnPwa').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('#btnPwa').hidden = true;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is optional */ });
  });
}
