/* AI Tok — personal vertical video feed. Single file, no deps. */
(() => {
'use strict';
const LS_KEY = 'aitok.v1', EV_KEY = 'aitok.events', HALF_LIFE_DAYS = 30, POOL = 3;
const $ = (s) => document.querySelector(s);
const feedEl = $('#feed');
let ITEMS = [], BY_ID = {};
let slides = [];            // {item, el, recycled}
let cur = -1;               // active slide index
let soundOn = false;
let session = null;         // current view stats
const pool = [];
let warmTimer = null;

// ---------- persistence ----------
function loadProfile() {
  let p; try { p = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) {}
  p = p || {};
  for (const k of ['topic', 'creator', 'seen', 'liked', 'disliked', 'saved', 'broken']) p[k] = p[k] || {};
  p.t = p.t || Date.now();
  const f = Math.pow(0.5, (Date.now() - p.t) / (HALF_LIFE_DAYS * 864e5)); // time decay of affinities
  for (const m of [p.topic, p.creator]) for (const k in m) { m[k].a *= f; m[k].b *= f; }
  p.t = Date.now();
  return p;
}
const P = loadProfile();
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(P)); } catch (e) {} }, 300); }
function logEvent(e) {
  let ev; try { ev = JSON.parse(localStorage.getItem(EV_KEY)) || []; } catch (x) { ev = []; }
  ev.push(Object.assign({ ts: Date.now() }, e));
  if (ev.length > 5000) ev = ev.slice(-5000);
  try { localStorage.setItem(EV_KEY, JSON.stringify(ev)); } catch (x) {}
}
function bump(map, key, a, b) { if (!key) return; const s = map[key] || (map[key] = { a: 0, b: 0 }); s.a += a; s.b += b; }
function reward(item, a, b) {
  const ts = item.topics && item.topics.length ? item.topics : [item.topic || 'other'];
  for (const t of ts) bump(P.topic, t, a / ts.length, b / ts.length);
  bump(P.creator, item.author, a, b);
  save();
}

// ---------- ranking: prior + Thompson-sampled topic/creator affinity + diversity ----------
function gammaSample(k) { // Marsaglia-Tsang, k>0
  if (k < 1) return gammaSample(k + 1) * Math.pow(Math.random(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { const u1 = Math.random(), u2 = Math.random(); x = Math.sqrt(-2 * Math.log(u1 || 1e-9)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = Math.random(); if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v; }
}
function betaSample(s) { const a = 1 + (s ? s.a : 0), b = 1 + (s ? s.b : 0); const x = gammaSample(a), y = gammaSample(b); return x / (x + y); }
function topicAff(item) { const ts = item.topics && item.topics.length ? item.topics : [item.topic || 'other']; let s = 0; for (const t of ts) s += betaSample(P.topic[t]); return s / ts.length; }
function pickNext() {
  const inQueue = new Set(slides.map(s => s.item.id));
  const recent = slides.slice(-3).map(s => s.item);
  let pool_ = ITEMS.filter(it => !P.seen[it.id] && !P.disliked[it.id] && !P.broken[it.id] && !inQueue.has(it.id));
  let recycled = false;
  if (!pool_.length) { // everything seen: replay liked/saved first, then oldest-seen
    recycled = true;
    pool_ = ITEMS.filter(it => !P.disliked[it.id] && !P.broken[it.id] && !inQueue.has(it.id));
    if (!pool_.length) return null;
  }
  const r = Math.random();
  if (r < 0.10) return { item: pool_[Math.floor(Math.random() * pool_.length)], recycled }; // 10% pure explore
  let best = null, bestS = -1e9;
  for (const it of pool_) {
    let s = it.prior || 0.5;
    s += 0.7 * (topicAff(it) - 0.5) + 0.5 * (betaSample(P.creator[it.author]) - 0.5);
    if (recent.some(x => x.author === it.author)) s -= 0.35;
    if (recent.length && recent[recent.length - 1].topic === it.topic) s -= 0.1;
    if (recycled) s += (P.saved[it.id] || P.liked[it.id] ? 0.4 : 0) - (P.seen[it.id] || 0) / 1e13;
    if (it.created_at) { const ageD = (Date.now() - Date.parse(it.created_at)) / 864e5; if (ageD < 10) s += 0.12; }
    s += Math.random() * 0.08;
    if (s > bestS) { bestS = s; best = it; }
  }
  return { item: best, recycled };
}

// ---------- DOM ----------
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function cleanText(t) { return (t || '').replace(/https?:\/\/t\.co\/\S+/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(); }
function makeSlide(item, recycled) {
  const el = document.createElement('section');
  el.className = 'slide' + (item.vertical ? ' vert' : '');
  const poster = item.poster ? `url("${item.poster}")` : 'none';
  const srcName = { x: 'X', hf: 'HF Papers', bsky: 'Bluesky' }[item.source] || item.source;
  el.innerHTML = `<div class="bg" style='background-image:${poster}'></div><div class="poster" style='background-image:${poster}'></div>
    <div class="spinner"></div>
    <div class="meta"><div class="who">@${esc(item.author)}<span class="src">${srcName}${item.lang === 'zh' ? ' · 中文' : ''}${recycled ? ' · 重温' : ''}</span></div>
      <div class="txt">${esc(cleanText(item.text))}</div><div class="tags">${item.topic && item.topic !== 'other' ? '#' + esc(item.topic) + ' · ' : ''}${Math.round(item.duration || 0)}s</div></div>
    <div class="side">
      <button class="like" title="喜欢">♥</button>
      <button class="dis" title="不喜欢">👎</button>
      <button class="save" title="收藏">★</button>
      <a class="open" href="${esc(item.url)}" target="_blank" rel="noopener" title="原帖">↗</a>
    </div><div class="progress"></div>`;
  const s = { item, el, recycled };
  el.querySelector('.like').onclick = (e) => { e.stopPropagation(); toggle('liked', s); };
  el.querySelector('.dis').onclick = (e) => { e.stopPropagation(); toggle('disliked', s); };
  el.querySelector('.save').onclick = (e) => { e.stopPropagation(); toggle('saved', s); };
  el.querySelector('.open').onclick = (e) => { e.stopPropagation(); logEvent({ type: 'open', id: item.id }); };
  el.addEventListener('click', () => togglePause(s));
  refreshButtons(s);
  return s;
}
function refreshButtons(s) {
  const id = s.item.id;
  s.el.querySelector('.like').classList.toggle('on', !!P.liked[id]);
  s.el.querySelector('.dis').classList.toggle('on', !!P.disliked[id]);
  s.el.querySelector('.save').classList.toggle('on', !!P.saved[id]);
}
function toggle(kind, s) {
  const id = s.item.id, on = !P[kind][id];
  if (on) P[kind][id] = Date.now(); else delete P[kind][id];
  const w = on ? 1 : -1;
  if (kind === 'liked') { reward(s.item, 2 * w, 0); if (on && P.disliked[id]) { delete P.disliked[id]; reward(s.item, 0, -3); } }
  if (kind === 'saved') reward(s.item, 3 * w, 0);
  if (kind === 'disliked') { reward(s.item, 0, 3 * w); if (on && P.liked[id]) { delete P.liked[id]; reward(s.item, -2, 0); } }
  logEvent({ type: kind, on, id });
  refreshButtons(s); save();
  toast({ liked: on ? '已喜欢' : '取消喜欢', saved: on ? '已收藏' : '取消收藏', disliked: on ? '少推这类，跳到下一个' : '已撤销' }[kind]);
  if (kind === 'disliked' && on) setTimeout(() => scrollToIndex(cur + 1), 350);
}
function appendMore(n) {
  for (let i = 0; i < n; i++) {
    const p = pickNext(); if (!p) break;
    const s = makeSlide(p.item, p.recycled);
    slides.push(s); feedEl.appendChild(s.el);
  }
}
function scrollToIndex(i) { if (i < 0) return; if (i >= slides.length) appendMore(3); feedEl.scrollTo({ top: i * feedEl.clientHeight, behavior: 'smooth' }); }

// ---------- video pool ----------
function makeVideo() {
  const v = document.createElement('video');
  v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
  v.muted = true; v.loop = true; v.preload = 'auto'; v.disablePictureInPicture = true;
  v.addEventListener('waiting', () => v._slide && v._slide.el.classList.add('loading'));
  v.addEventListener('playing', () => { if (v._slide) { v._slide.el.classList.remove('loading'); } });
  v.addEventListener('canplay', () => v._slide && v._slide.el.classList.remove('loading'));
  v.addEventListener('timeupdate', () => onTime(v));
  v.addEventListener('error', () => onVideoError(v));
  pool.push(v); return v;
}
for (let i = 0; i < POOL; i++) makeVideo();
function srcFor(item, low) { return low ? (item.mp4_low || item.mp4) : item.mp4; }
function attach(v, s) {
  if (v._slide === s) return;
  v.pause(); v._slide = s; v._low = false; v._warm = false;
  v.src = srcFor(s.item, false); v.load();
  s.el.insertBefore(v, s.el.querySelector('.spinner'));
}
function onVideoError(v) {
  const s = v._slide; if (!s) return;
  if (!v._low && s.item.mp4_low && s.item.mp4_low !== s.item.mp4) { v._low = true; v.src = srcFor(s.item, true); v.load(); if (slides[cur] === s) playActive(); return; }
  P.broken[s.item.id] = Date.now(); save(); logEvent({ type: 'broken', id: s.item.id });
  s.el.classList.remove('loading');
  s.el.querySelector('.txt').textContent = '⚠️ 视频已失效（可能原帖被删）。上滑继续，或点 ↗ 看原帖。';
}
function assignPool() {
  const want = [cur, cur + 1, cur + 2].map(i => slides[i]).filter(Boolean);
  const free = pool.filter(v => !want.includes(v._slide));
  for (const s of want) {
    if (pool.some(v => v._slide === s)) continue;
    const v = free.shift(); if (v) attach(v, s);
  }
  for (const v of pool) if (v._slide !== slides[cur]) v.pause();
  // warm-up the next clips only after the active one can play, so it gets the bandwidth first.
  // (iOS ignores preload=auto, so a brief muted play() is what actually forces buffering.)
  const act = videoOf(slides[cur]);
  const go = () => { for (const v of pool) if (v._slide && v._slide !== slides[cur] && !v._warm) { v._warm = true; warm(v); } };
  if (!act || act.readyState >= 3) go(); else act.addEventListener('canplay', go, { once: true });
}
function warm(v) {
  const s = v._slide; const wasMuted = v.muted; v.muted = true;
  const p = v.play();
  const stop = () => { if (v._slide !== slides[cur]) { v.pause(); try { v.currentTime = 0; } catch (e) {} v.muted = !soundOn; } };
  if (p && p.then) p.then(() => setTimeout(stop, 250)).catch(() => { v.muted = wasMuted; }); else setTimeout(stop, 250);
}
function videoOf(s) { return pool.find(v => v._slide === s); }
function playActive() {
  const s = slides[cur]; const v = videoOf(s); if (!v) return;
  v.muted = !soundOn;
  s.el.classList.remove('paused');
  const p = v.play();
  if (p && p.catch) p.catch(() => { // autoplay with sound refused -> fall back to muted
    v.muted = true; v.play().catch(() => s.el.classList.add('paused'));
  });
}
function togglePause(s) {
  if (slides[cur] !== s) return;
  const v = videoOf(s); if (!v) return;
  if (v.paused) { v.muted = !soundOn; v.play().catch(() => {}); s.el.classList.remove('paused'); logEvent({ type: 'resume', id: s.item.id }); }
  else { v.pause(); s.el.classList.add('paused'); logEvent({ type: 'pause', id: s.item.id }); }
}

// ---------- watch-time / skip / rewatch logging ----------
function onTime(v) {
  const s = v._slide; if (!s || s !== slides[cur] || !session) return;
  const t = v.currentTime, d = v.duration || s.item.duration || 1;
  const dt = t - session.last;
  if (dt > 0 && dt < 1.5) session.watched += dt;
  else if (dt < -1 && session.last > d - 2) session.loops += 1; // wrapped around => rewatch
  session.last = t;
  const bar = s.el.querySelector('.progress'); bar.style.width = (100 * t / d) + '%';
}
function endSession() {
  if (!session) return;
  const { s, watched, loops, start } = session; session = null;
  const d = s.item.duration || 30;
  const completion = Math.min(1, watched / d);
  const skip = watched < 3 && completion < 0.3;
  P.seen[s.item.id] = Date.now();
  // reward: completion + rewatch bonus; quick skip is a strong negative
  const a = completion >= 0.9 ? 1 + 0.5 * Math.min(loops, 3) : completion * 0.8;
  const b = skip ? 1 : (completion < 0.5 ? 0.5 * (1 - completion) : 0);
  reward(s.item, a, b);
  logEvent({ type: 'view', id: s.item.id, watched: +watched.toFixed(1), dur: d, completion: +completion.toFixed(2), loops, skip, dwell: Math.round((Date.now() - start) / 1000) });
}
function activate(i) {
  if (i === cur || i < 0 || i >= slides.length) return;
  endSession();
  if (slides[cur]) { const ov = videoOf(slides[cur]); if (ov) ov.pause(); slides[cur].el.classList.remove('paused'); }
  cur = i;
  if (cur >= slides.length - 3) appendMore(4);
  assignPool();
  const v = videoOf(slides[cur]);
  if (v) { try { v.currentTime = 0; } catch (e) {} }
  session = { s: slides[cur], watched: 0, loops: 0, last: 0, start: Date.now() };
  playActive();
  status();
}
let scrollT = null;
feedEl.addEventListener('scroll', () => {
  const h = feedEl.clientHeight, i = Math.round(feedEl.scrollTop / h);
  clearTimeout(scrollT);
  if (Math.abs(feedEl.scrollTop - i * h) < 3) activate(i); else scrollT = setTimeout(() => activate(Math.round(feedEl.scrollTop / feedEl.clientHeight)), 90);
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  const v = slides[cur] && videoOf(slides[cur]);
  if (document.hidden) { if (v) v.pause(); } else if (v && !slides[cur].el.classList.contains('paused')) playActive();
});
window.addEventListener('pagehide', endSession);

// ---------- sound (one tap, whole session) ----------
function setSound(on) {
  soundOn = on;
  for (const v of pool) {        // "bless" every pooled element inside the user gesture so later swipes can play with sound
    v.muted = !on || v._slide !== slides[cur];
    if (v._slide !== slides[cur]) { const p = v.play(); if (p && p.then) p.then(() => { if (v._slide !== slides[cur]) v.pause(); v.muted = !on; }).catch(() => {}); }
  }
  const v = videoOf(slides[cur]); if (v) { v.muted = !on; v.play().catch(() => {}); slides[cur].el.classList.remove('paused'); }
  $('#btnSound').textContent = on ? '🔊' : '🔇 点我开声音';
  try { sessionStorage.setItem('aitok.sound', on ? '1' : '0'); } catch (e) {}
}
$('#btnSound').onclick = (e) => { e.stopPropagation(); setSound(!soundOn); };

// ---------- saved / liked / history panel ----------
let tab = 'saved';
function renderPanel() {
  const m = tab === 'history' ? P.seen : P[tab];
  const ids = Object.keys(m).filter(id => BY_ID[id]).sort((a, b) => m[b] - m[a]).slice(0, 300);
  const list = $('#savedList');
  list.innerHTML = ids.length ? '' : '<div class="empty">还没有内容</div>';
  for (const id of ids) {
    const it = BY_ID[id]; const b = document.createElement('button'); b.className = 'cell';
    if (it.poster) b.style.backgroundImage = `url("${it.poster}")`;
    b.innerHTML = `<span>@${esc(it.author)} · ${esc(cleanText(it.text).slice(0, 40))}</span>`;
    b.onclick = () => openItem(it); list.appendChild(b);
  }
  for (const k of ['saved', 'liked', 'history']) $('#tab' + k[0].toUpperCase() + k.slice(1)).classList.toggle('on', k === tab);
}
function openItem(it) {
  $('#savedPanel').classList.add('hidden');
  const s = makeSlide(it, true);
  const at = cur + 1; slides.splice(at, 0, s); feedEl.insertBefore(s.el, slides[at + 1] ? slides[at + 1].el : null);
  assignPool(); scrollToIndex(at);
}
$('#btnSaved').onclick = () => { renderPanel(); $('#savedPanel').classList.remove('hidden'); const v = videoOf(slides[cur]); if (v) v.pause(); };
$('#btnClose').onclick = () => { $('#savedPanel').classList.add('hidden'); playActive(); };
$('#tabSaved').onclick = () => { tab = 'saved'; renderPanel(); };
$('#tabLiked').onclick = () => { tab = 'liked'; renderPanel(); };
$('#tabHistory').onclick = () => { tab = 'history'; renderPanel(); };
$('#btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify({ profile: P, events: JSON.parse(localStorage.getItem(EV_KEY) || '[]') })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'aitok-signals.json'; a.click();
};
$('#btnReset').onclick = () => { if (confirm('清空推荐画像（保留收藏）？')) { P.topic = {}; P.creator = {}; P.seen = {}; save(); location.reload(); } };

function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('hidden'), 1100); }
function status() { const left = ITEMS.filter(it => !P.seen[it.id] && !P.disliked[it.id]).length; $('#status').textContent = `${left} 条未看`; }

// ---------- boot ----------
async function boot() {
  let feed;
  try { feed = await (await fetch('feed.json', { cache: 'no-cache' })).json(); }
  catch (e) { $('#status').textContent = '加载失败，下拉刷新'; return; }
  ITEMS = feed.items.filter(it => it.mp4);
  BY_ID = {}; for (const it of ITEMS) BY_ID[it.id] = it;
  appendMore(5);
  activate(0);
  window.__aitok = { slides: () => slides, cur: () => cur, pool, P, activate, scrollToIndex };
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
})();
