/* AI Tok — personal vertical video feed. Single file, no deps. */
(() => {
'use strict';
const LS_KEY = 'aitok.v1', EV_KEY = 'aitok.events', SOUND_KEY = 'aitok.sound', HALF_LIFE_DAYS = 30, POOL = 4;
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
  for (const k of ['topic', 'creator', 'seen', 'liked', 'disliked', 'saved', 'broken', 'followed']) p[k] = p[k] || {};
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

// ---------- text helpers ----------
const TOPIC_ZH = { 'llm-arch': '大模型架构', 'math': '数学', 'physics': '物理', 'agents': '智能体', 'rl-post': '强化学习·后训练',
  'gpu-sys': 'GPU·系统', 'inference': '推理加速', 'ml-basics': '机器学习基础', 'robotics': '机器人', 'moe-scale': 'MoE·扩展',
  'vision': '视觉', 'diffusion': '扩散模型', 'coding': 'AI 编程', 'optim': '优化器', 'interp': '可解释性', 'theory': '理论' };
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function cleanText(t) { return (t || '').replace(/https?:\/\/t\.co\/\S+/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(); }
function fmtCount(n) { n = n || 0; if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + '万'; if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'; return String(n); }
function fmtTime(s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function fmtWhen(iso) {
  const t = Date.parse(iso || ''); if (!t) return '';
  const m = (Date.now() - t) / 6e4;
  if (m < 60) return '刚刚'; if (m < 1440) return Math.floor(m / 60) + '小时前'; if (m < 1440 * 30) return Math.floor(m / 1440) + '天前';
  const d = new Date(t), y = d.getFullYear() === new Date().getFullYear();
  return (y ? '' : d.getFullYear() + '-') + (d.getMonth() + 1) + '-' + d.getDate();
}
function hue(s) { let h = 0; for (const c of s || '') h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function headline(it) { return it.title_zh || it.summary_zh || it.title || ''; }
function bodyText(it) { return cleanText(it.text); }
function haptic(ms) { try { navigator.vibrate && navigator.vibrate(ms || 8); } catch (e) {} }
const svg = (id) => `<svg><use href="#${id}"/></svg>`;

// ---------- DOM ----------
function makeSlide(item, recycled) {
  const el = document.createElement('section');
  const asp = (item.width > 0 && item.height > 0) ? item.width / item.height : (item.vertical ? 9 / 16 : 16 / 9);
  const land = asp > 1.05;   // fill only phone-shaped clips; everything else fits over a blurred backdrop
  el.className = 'slide' + (asp < 0.67 ? ' vert' : '') + (land ? ' land' : '');
  const poster = item.poster ? `url("${item.poster}")` : 'none';
  const srcName = { x: 'X', hf: 'HF Papers', bsky: 'Bluesky' }[item.source] || item.source;
  const topics = (item.topics && item.topics.length ? item.topics : [item.topic]).filter(t => t && t !== 'other');
  const head = headline(item), body = bodyText(item);
  const h = hue(item.author);
  const av = item.avatar ? `style='background-image:url("${esc(item.avatar)}")'` : `style="background:linear-gradient(135deg,hsl(${h},75%,55%),hsl(${(h + 50) % 360},80%,45%))"`;
  el.innerHTML = `<div class="bg" style='background-image:${poster}'></div><div class="poster" style='background-image:${poster}'></div>
    <div class="shade-top"></div><div class="shade-bot"></div>
    <div class="pause-ico">${svg('i-play')}</div>
    <div class="rail">
      <button class="avatar${P.followed[item.author] ? ' fol' : ''}" ${av} aria-label="多推这个作者">${item.avatar ? '' : esc((item.author_name || item.author || '?').trim()[0] || '?').toUpperCase()}<span class="plus">${P.followed[item.author] ? '✓' : '+'}</span></button>
      <button class="act like" aria-label="喜欢"><span class="ico">${svg('i-heart')}</span><span class="n"></span></button>
      <button class="act save" aria-label="收藏"><span class="ico">${svg('i-bookmark')}</span><span>收藏</span></button>
      <button class="act share" aria-label="分享"><span class="ico">${svg('i-share')}</span><span>分享</span></button>
      <button class="act dis" aria-label="不感兴趣"><span class="ico">${svg('i-nope')}</span><span>不感兴趣</span></button>
    </div>
    <div class="meta">
      <div class="who">@${esc(item.author)}<span class="when">${fmtWhen(item.created_at)}</span></div>
      <div class="cap">${head ? `<span class="zh">${esc(head)}</span> ` : ''}${esc(body)}</div>
      <button class="more hidden">展开</button>
      <div class="chips">${recycled ? '<span class="chip re">重温</span>' : ''}${item.lang === 'zh' ? '<span class="chip lang">中文</span>' : ''}${topics.slice(0, 3).map(t => `<span class="chip">#${esc(TOPIC_ZH[t] || t)}</span>`).join('')}<a class="chip src" href="${esc(item.url)}" target="_blank" rel="noopener">${srcName} 原帖${svg('i-ext')}</a></div>
    </div>
    ${land ? `<button class="fs-btn" style="top:calc(50% + ${(50 / asp).toFixed(2)}vw + 16px)">${svg('i-full')}全屏观看</button>` : ''}
    <div class="timecode"></div>
    <div class="scrub"><div class="track"><div class="fill"></div><div class="knob"></div></div></div>`;
  const s = { item, el, recycled };
  const q = (c) => el.querySelector(c);
  s.fill = q('.fill'); s.knob = q('.knob'); s.tc = q('.timecode');
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  q('.like').onclick = stop(() => toggle('liked', s));
  q('.dis').onclick = stop(() => toggle('disliked', s));
  q('.save').onclick = stop(() => toggle('saved', s));
  q('.share').onclick = stop(() => share(s));
  q('.avatar').onclick = stop(() => follow(s));
  if (land) q('.fs-btn').onclick = stop(() => fullscreen(s));
  q('.src').onclick = (e) => { e.stopPropagation(); logEvent({ type: 'open', id: item.id }); };
  q('.more').onclick = stop(() => { const m = q('.meta'), open = m.classList.toggle('open'); q('.more').textContent = open ? '收起' : '展开'; });
  q('.cap').onclick = stop(() => { if (!q('.more').classList.contains('hidden')) q('.more').click(); });
  bindGestures(s); bindScrub(s);
  refreshButtons(s);
  return s;
}
function refreshButtons(s) {
  const id = s.item.id, q = (c) => s.el.querySelector(c);
  q('.like').classList.toggle('on', !!P.liked[id]);
  const n = (s.item.likes || 0) + (P.liked[id] ? 1 : 0);
  q('.like .n').textContent = n ? fmtCount(n) : '赞';
  q('.dis').classList.toggle('on', !!P.disliked[id]);
  q('.save').classList.toggle('on', !!P.saved[id]);
}
function toggle(kind, s, forceOn) {
  const id = s.item.id, on = forceOn ? true : !P[kind][id];
  if (forceOn && P[kind][id]) return;
  if (on) P[kind][id] = Date.now(); else delete P[kind][id];
  const w = on ? 1 : -1;
  if (kind === 'liked') { reward(s.item, 2 * w, 0); if (on && P.disliked[id]) { delete P.disliked[id]; reward(s.item, 0, -3); } }
  if (kind === 'saved') reward(s.item, 3 * w, 0);
  if (kind === 'disliked') { reward(s.item, 0, 3 * w); if (on && P.liked[id]) { delete P.liked[id]; reward(s.item, -2, 0); } }
  logEvent({ type: kind, on, id });
  refreshButtons(s); save(); haptic(on ? 12 : 6);
  if (kind !== 'liked') toast({ saved: on ? '已收藏' : '已取消收藏', disliked: on ? '好的，少推这类' : '已撤销' }[kind]);
  if (kind === 'disliked' && on) setTimeout(() => scrollToIndex(cur + 1), 450);
}
function follow(s) {
  const a = s.item.author; if (!a) return;
  const on = !P.followed[a];
  if (on) P.followed[a] = Date.now(); else delete P.followed[a];
  bump(P.creator, a, on ? 3 : -3, 0); save();
  logEvent({ type: 'follow', on, id: s.item.id, author: a }); haptic(10);
  for (const x of slides) if (x.item.author === a) { const av = x.el.querySelector('.avatar'); av.classList.toggle('fol', on); av.querySelector('.plus').textContent = on ? '✓' : '+'; }
  toast(on ? `会多推 @${a}` : '已取消');
}
async function share(s) {
  const it = s.item, url = it.url; logEvent({ type: 'share', id: it.id });
  try { if (navigator.share) { await navigator.share({ title: headline(it) || ('@' + it.author), url }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('链接已复制'); } catch (e) { window.open(url, '_blank', 'noopener'); }
}
// 全屏观看: iOS Safari -> native fullscreen player (rotates to landscape); elsewhere -> element fullscreen + landscape lock
function fullscreen(s) {
  const v = videoOf(s); if (!v || slides[cur] !== s) return;
  logEvent({ type: 'fullscreen', id: s.item.id });
  if (v.webkitEnterFullscreen && !document.fullscreenEnabled) {
    v.addEventListener('webkitendfullscreen', () => { if (slides[cur] === s) playActive(); }, { once: true });
    try { v.webkitEnterFullscreen(); } catch (e) {}
    return;
  }
  const r = s.el.requestFullscreen ? s.el.requestFullscreen() : null;
  if (r && r.then) r.then(() => { try { screen.orientation.lock('landscape').catch(() => {}); } catch (e) {} }).catch(() => {});
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { try { screen.orientation.unlock(); } catch (e) {} } });
function burst(s, x, y) {
  const b = document.createElement('div'); b.className = 'burst'; b.innerHTML = svg('i-heart');
  b.style.left = x + 'px'; b.style.top = y + 'px'; b.style.setProperty('--r', (Math.random() * 40 - 20).toFixed(0) + 'deg');
  s.el.appendChild(b); setTimeout(() => b.remove(), 850);
}
let endEl = null;
function appendMore(n) {
  for (let i = 0; i < n; i++) {
    const p = pickNext();
    if (!p) { if (!endEl) { endEl = document.createElement('section'); endEl.className = 'slide end';
      endEl.innerHTML = `<div class="state-card"><div class="state-emoji">🎉</div><div class="state-title">全部看完啦</div><div class="state-sub">新视频每天早上自动补充。<br>先去收藏里重温一下？</div><button class="btn-primary">打开收藏</button></div>`;
      endEl.querySelector('button').onclick = () => setMode('lib'); feedEl.appendChild(endEl); } break; }
    const s = makeSlide(p.item, p.recycled);
    slides.push(s); feedEl.insertBefore(s.el, endEl);
  }
}
function scrollToIndex(i, instant) { if (i < 0) return; if (i >= slides.length) appendMore(3); feedEl.scrollTo({ top: i * feedEl.clientHeight, behavior: instant ? 'auto' : 'smooth' }); }

// ---------- gestures: tap = pause, double-tap = like, long-press = 2x ----------
function bindGestures(s) {
  const el = s.el; let down = null, lpTimer = null, tapTimer = null, lastTap = 0, lastX = 0, lastY = 0, longOn = false;
  const isUI = (t) => t.closest('.rail,.meta,.scrub,.broken-card,a,button');
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('pointerdown', e => {
    if (isUI(e.target) || e.button > 0) return;
    down = { x: e.clientX, y: e.clientY, t: Date.now() };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => { if (!down || slides[cur] !== s) return; const v = videoOf(s); if (!v || v.paused) return;
      longOn = true; v.playbackRate = 2; $('#speedPill').classList.add('on'); haptic(10); logEvent({ type: 'speed2x', id: s.item.id }); }, 420);
  });
  el.addEventListener('pointermove', e => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) { clearTimeout(lpTimer); down = null; } });
  const endLong = () => { if (longOn) { longOn = false; const v = videoOf(s); if (v) v.playbackRate = 1; $('#speedPill').classList.remove('on'); return true; } return false; };
  el.addEventListener('pointercancel', () => { clearTimeout(lpTimer); down = null; endLong(); });
  el.addEventListener('pointerup', e => {
    clearTimeout(lpTimer);
    if (endLong()) { down = null; return; }
    if (!down) return; down = null;
    const now = Date.now();
    if (now - lastTap < 300 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 60) {
      clearTimeout(tapTimer); lastTap = 0;
      const r = el.getBoundingClientRect(); burst(s, e.clientX - r.left, e.clientY - r.top); toggle('liked', s, true); haptic(14);
      return;
    }
    lastTap = now; lastX = e.clientX; lastY = e.clientY;
    clearTimeout(tapTimer); tapTimer = setTimeout(() => togglePause(s), 260);
  });
}
function bindScrub(s) {
  const bar = s.el.querySelector('.scrub');
  let active = false, wasPaused = false;
  const frac = (e) => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const show = (f) => { const v = videoOf(s), d = (v && v.duration) || s.item.duration || 0; paintProgress(s, f); s.tc.innerHTML = `${fmtTime(f * d)} <span>/ ${fmtTime(d)}</span>`; return f * d; };
  bar.addEventListener('pointerdown', e => {
    if (slides[cur] !== s) return; e.stopPropagation(); const v = videoOf(s); if (!v) return;
    active = true; bar.setPointerCapture(e.pointerId); wasPaused = v.paused; v.pause(); s.el.classList.add('scrubbing'); show(frac(e));
    if (session) session.scrub = true;
  });
  bar.addEventListener('pointermove', e => { if (!active) return; const t = show(frac(e)); const v = videoOf(s); if (v && v.fastSeek) v.fastSeek(t); else if (v) v.currentTime = t; });
  const end = (e) => { if (!active) return; active = false; s.el.classList.remove('scrubbing'); const v = videoOf(s); if (!v) return;
    const t = show(frac(e)); try { v.currentTime = t; } catch (x) {} if (session) { session.last = t; session.scrub = false; }
    logEvent({ type: 'seek', id: s.item.id, to: +t.toFixed(1) }); if (!wasPaused) { v.play().catch(() => {}); s.el.classList.remove('paused'); } };
  bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
}
function paintProgress(s, f) { s.fill.style.transform = `scaleX(${f})`; s.knob.style.left = (f * 100) + '%'; }
(function raf() { const s = slides[cur], v = s && videoOf(s); if (v && v.duration && !s.el.classList.contains('scrubbing')) paintProgress(s, v.currentTime / v.duration); requestAnimationFrame(raf); })();

// ---------- video pool ----------
function makeVideo() {
  const v = document.createElement('video');
  v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
  v.muted = true; v.loop = true; v.preload = 'auto'; v.disablePictureInPicture = true; v.setAttribute('disableremoteplayback', '');
  const sl = () => v._slide && v._slide.el;
  v.addEventListener('waiting', () => sl() && sl().classList.add('loading'));
  v.addEventListener('playing', () => { if (sl()) { sl().classList.remove('loading'); sl().classList.add('ready'); onFirstFrame(); } });
  v.addEventListener('loadeddata', () => sl() && sl().classList.add('ready'));
  v.addEventListener('canplay', () => sl() && sl().classList.remove('loading'));
  v.addEventListener('timeupdate', () => onTime(v));
  v.addEventListener('error', () => onVideoError(v));
  pool.push(v); return v;
}
for (let i = 0; i < POOL; i++) makeVideo();
function srcFor(item, low) { return low ? (item.mp4_low || item.mp4) : item.mp4; }
function attach(v, s) {
  if (v._slide === s) return;
  if (v._slide) v._slide.el.classList.remove('ready', 'loading');
  v.pause(); v.playbackRate = 1; v._slide = s; v._low = false; v._warm = false;
  v.src = srcFor(s.item, false); v.load();
  s.el.insertBefore(v, s.el.querySelector('.shade-top'));
}
function onVideoError(v) {
  const s = v._slide; if (!s) return;
  if (!v._low && s.item.mp4_low && s.item.mp4_low !== s.item.mp4) { v._low = true; v.src = srcFor(s.item, true); v.load(); if (slides[cur] === s) playActive(); return; }
  P.broken[s.item.id] = Date.now(); save(); logEvent({ type: 'broken', id: s.item.id });
  s.el.classList.remove('loading');
  if (!s.el.querySelector('.broken-card')) {
    const c = document.createElement('div'); c.className = 'broken-card';
    c.innerHTML = `<b>视频已失效</b><p>原帖可能被删了，之后不会再推这条</p><a class="btn-sec" href="${esc(s.item.url)}" target="_blank" rel="noopener">看原帖</a>`;
    s.el.appendChild(c);
  }
}
function assignPool() {
  const want = [cur, cur + 1, cur - 1, cur + 2].map(i => slides[i]).filter(Boolean);
  const free = pool.filter(v => !want.includes(v._slide));
  for (const s of want) {
    if (pool.some(v => v._slide === s)) continue;
    const v = free.shift(); if (v) attach(v, s);
  }
  for (const v of pool) if (v._slide !== slides[cur]) { v.pause(); v.playbackRate = 1; }
  // warm-up the neighbours only after the active one can play, so it gets the bandwidth first.
  // (iOS ignores preload=auto, so a brief muted play() is what actually forces buffering.)
  const act = videoOf(slides[cur]);
  const go = () => { for (const v of pool) if (v._slide && v._slide !== slides[cur] && !v._warm) { v._warm = true; warm(v); } };
  if (!act || act.readyState >= 3) go(); else act.addEventListener('canplay', go, { once: true });
}
function warm(v) {
  const wasMuted = v.muted; v.muted = true;
  const p = v.play();
  const stop = () => { if (v._slide !== slides[cur]) { v.pause(); try { v.currentTime = 0; } catch (e) {} v.muted = !soundOn; } };
  if (p && p.then) p.then(() => setTimeout(stop, 250)).catch(() => { v.muted = wasMuted; }); else setTimeout(stop, 250);
}
function videoOf(s) { return s && pool.find(v => v._slide === s); }
function playActive() {
  const s = slides[cur]; const v = videoOf(s); if (!v) return;
  v.muted = !soundOn;
  s.el.classList.remove('paused');
  const p = v.play();
  if (p && p.catch) p.catch(() => { // autoplay with sound refused -> fall back to muted
    v.muted = true; if (soundOn) { soundOn = false; paintSound(); } v.play().catch(() => s.el.classList.add('paused'));
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
  const s = v._slide; if (!s || s !== slides[cur] || !session || session.scrub) return;
  const t = v.currentTime, d = v.duration || s.item.duration || 1;
  const dt = t - session.last;
  if (dt > 0 && dt < 1.5 * (v.playbackRate || 1)) session.watched += dt;
  else if (dt < -1 && session.last > d - 2) session.loops += 1; // wrapped around => rewatch
  session.last = t;
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
let recycleNoticed = false, hintDone = false;
function activate(i) {
  if (i === cur || i < 0 || i >= slides.length) return;
  endSession();
  if (slides[cur]) { const ov = videoOf(slides[cur]); if (ov) { ov.pause(); ov.playbackRate = 1; } slides[cur].el.classList.remove('paused', 'scrubbing'); const m = slides[cur].el.querySelector('.meta.open'); if (m) { m.classList.remove('open'); m.querySelector('.more').textContent = '展开'; } }
  cur = i;
  if (cur >= slides.length - 3) appendMore(4);
  assignPool();
  const v = videoOf(slides[cur]);
  if (v) { try { v.currentTime = 0; } catch (e) {} }
  session = { s: slides[cur], watched: 0, loops: 0, last: 0, start: Date.now() };
  playActive();
  measureCaption(slides[cur]);
  if (cur >= 3) { hintDone = true; paintSound(); }
  if (slides[cur].recycled && !recycleNoticed) { recycleNoticed = true; toast('新视频看完了，开始重温精选'); }
  status();
}
function measureCaption(s) { const c = s.el.querySelector('.cap'), m = s.el.querySelector('.more'); requestAnimationFrame(() => m.classList.toggle('hidden', c.scrollHeight <= c.clientHeight + 2)); }
let scrollT = null, atEnd = false;
function settle(i) {
  if (i >= slides.length) { atEnd = true; const v = videoOf(slides[cur]); if (v) v.pause(); return; }
  if (atEnd && i === cur) { atEnd = false; if (!slides[cur].el.classList.contains('paused')) playActive(); return; }
  atEnd = false; activate(i);
}
feedEl.addEventListener('scroll', () => {
  const h = feedEl.clientHeight, i = Math.round(feedEl.scrollTop / h);
  clearTimeout(scrollT);
  if (Math.abs(feedEl.scrollTop - i * h) < 3) settle(i); else scrollT = setTimeout(() => settle(Math.round(feedEl.scrollTop / feedEl.clientHeight)), 90);
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  const v = slides[cur] && videoOf(slides[cur]);
  if (document.hidden) { if (v) v.pause(); } else if (v && mode === 'feed' && !slides[cur].el.classList.contains('paused')) playActive();
});
window.addEventListener('pagehide', endSession);
window.addEventListener('resize', () => { if (cur >= 0) feedEl.scrollTo({ top: cur * feedEl.clientHeight }); });

// ---------- sound (remembered; browsers need one tap before audio) ----------
function paintSound() { $('#btnSound').innerHTML = svg(soundOn ? 'i-sound' : 'i-muted'); $('#soundHint').classList.toggle('hidden', soundOn || hintDone || mode !== 'feed' || pref('0') === '0x'); }
function pref(d) { try { return localStorage.getItem(SOUND_KEY) || d; } catch (e) { return d; } }
function setSound(on) {
  soundOn = on;
  for (const v of pool) {        // "bless" every pooled element inside the user gesture so later swipes can play with sound
    v.muted = !on || v._slide !== slides[cur];
    if (v._slide && v._slide !== slides[cur]) { const p = v.play(); if (p && p.then) p.then(() => { if (v._slide !== slides[cur]) v.pause(); v.muted = !on; }).catch(() => {}); }
  }
  const v = videoOf(slides[cur]); if (v && mode === 'feed') { v.muted = !on; v.play().catch(() => {}); slides[cur].el.classList.remove('paused'); }
  try { localStorage.setItem(SOUND_KEY, on ? '1' : '0x'); } catch (e) {}
  paintSound();
}
$('#btnSound').onclick = (e) => { e.stopPropagation(); setSound(!soundOn); haptic(6); };
$('#soundHint').onclick = (e) => { e.stopPropagation(); setSound(true); };
// remembered "sound on": restore it on the first touch anywhere (that touch is the gesture the browser needs)
document.addEventListener('pointerdown', function first(e) {
  document.removeEventListener('pointerdown', first, true);
  if (pref('0') === '1' && !soundOn && !e.target.closest('#btnSound')) setSound(true);
}, true);

// ---------- pull-to-refresh (drag down on the first clip) ----------
let ptr = null;
feedEl.addEventListener('touchstart', e => { ptr = (cur === 0 && feedEl.scrollTop <= 0 && mode === 'feed') ? { y: e.touches[0].clientY, d: 0 } : null; }, { passive: true });
feedEl.addEventListener('touchmove', e => {
  if (!ptr) return; ptr.d = Math.max(0, e.touches[0].clientY - ptr.y);
  const d = Math.min(90, ptr.d * 0.5), el = $('#ptr');
  el.style.transform = `translate(-50%, ${d - 40}px)`; el.style.opacity = Math.min(1, d / 50);
  el.querySelector('span').textContent = d > 60 ? '松开刷新' : '下拉刷新'; el.classList.toggle('arm', d > 60);
}, { passive: true });
feedEl.addEventListener('touchend', () => {
  if (!ptr) return; const go = ptr.d * 0.5 > 60; ptr = null; const el = $('#ptr');
  if (go) { el.classList.add('spin'); el.querySelector('span').textContent = '刷新中'; refreshFeed().finally(() => { el.classList.remove('spin', 'arm'); el.style.opacity = 0; el.style.transform = ''; }); }
  else { el.style.opacity = 0; el.style.transform = ''; }
});
async function refreshFeed() {
  try { const r = await fetch('feed.json', { cache: 'no-cache' }); if (!r.ok) throw 0; const feed = await r.json(); ITEMS = (feed.items || []).filter(it => it.mp4); BY_ID = {}; for (const it of ITEMS) BY_ID[it.id] = it; }
  catch (e) { toast('刷新失败，稍后再试'); return; }
  endSession();
  for (const v of pool) { v.pause(); if (v._slide) v._slide.el.classList.remove('ready'); v._slide = null; v.removeAttribute('src'); v.load(); v.remove(); }
  for (const x of slides) x.el.remove(); if (endEl) { endEl.remove(); endEl = null; }
  slides = []; cur = -1; recycleNoticed = false;
  appendMore(5); feedEl.scrollTo({ top: 0 }); if (slides.length) activate(0);
  toast('已刷新');
}

// ---------- top tabs + library ----------
let mode = 'feed', libTab = 'saved';
function placeInk() { const t = $(mode === 'feed' ? '#tabFeed' : '#tabLib'), ink = $('#tabInk'); ink.style.transform = `translateX(${t.offsetLeft + (t.offsetWidth - 22) / 2}px)`; }
function setMode(m) {
  if (m === mode) { if (m === 'feed' && cur >= 0) scrollToIndex(cur); return; }
  mode = m; document.body.classList.toggle('lib-mode', m === 'lib');
  $('#tabFeed').classList.toggle('on', m === 'feed'); $('#tabLib').classList.toggle('on', m === 'lib');
  $('#library').setAttribute('aria-hidden', m !== 'lib'); placeInk();
  const v = videoOf(slides[cur]);
  if (m === 'lib') { renderLib(); if (v) v.pause(); }
  else if (v && !slides[cur].el.classList.contains('paused')) playActive();
  paintSound();
}
$('#tabFeed').onclick = () => setMode('feed');
$('#tabLib').onclick = () => setMode('lib');
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { libTab = b.dataset.k; renderLib(); });
function renderLib() {
  const maps = { saved: P.saved, liked: P.liked, history: P.seen };
  const ids = (k) => Object.keys(maps[k]).filter(id => BY_ID[id]).sort((a, b) => maps[k][b] - maps[k][a]);
  $('#cSaved').textContent = ids('saved').length; $('#cLiked').textContent = ids('liked').length; $('#cHistory').textContent = ids('history').length;
  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.k === libTab));
  const list = ids(libTab).slice(0, 300), grid = $('#libGrid');
  if (!list.length) {
    const msg = { saved: ['还没有收藏', '看到想反复看的，点右侧的书签'], liked: ['还没有喜欢的视频', '双击视频或点爱心'], history: ['还没有观看记录', '回到推荐刷几条吧'] }[libTab];
    grid.innerHTML = `<div class="lib-empty"><div class="big">${svg(libTab === 'liked' ? 'i-heart' : 'i-bookmark')}</div><b>${msg[0]}</b>${msg[1]}</div>`; return;
  }
  grid.innerHTML = '';
  list.forEach((id, k) => {
    const it = BY_ID[id], b = document.createElement('button'); b.className = 'cell'; b.style.animationDelay = Math.min(k, 18) * 18 + 'ms';
    if (it.poster) b.style.backgroundImage = `url("${it.poster}")`;
    b.innerHTML = `<span class="c-dur">${fmtTime(it.duration)}</span><span class="c-cap">${esc((headline(it) || bodyText(it)).slice(0, 60))}<span class="c-who">@${esc(it.author)}</span></span>`;
    b.onclick = () => openItem(it); grid.appendChild(b);
  });
}
function openItem(it) {
  const at = cur + 1, s = makeSlide(it, true);
  slides.splice(at, 0, s); feedEl.insertBefore(s.el, slides[at + 1] ? slides[at + 1].el : endEl);
  setMode('feed'); assignPool(); setTimeout(() => scrollToIndex(at), 60);
}
$('#btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify({ profile: P, events: JSON.parse(localStorage.getItem(EV_KEY) || '[]') })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'aitok-signals.json'; a.click();
};
$('#btnReset').onclick = () => { if (confirm('清空推荐画像（保留收藏和喜欢）？')) { P.topic = {}; P.creator = {}; P.seen = {}; save(); setTimeout(() => location.reload(), 350); } };

function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('on'), 1300); }
function status() {}
let booted = false;
function onFirstFrame() { if (booted) return; booted = true; $('#boot').classList.add('gone'); }

// ---------- boot ----------
async function boot() {
  $('#errorState').classList.add('hidden');
  let feed;
  try { const r = await fetch('feed.json', { cache: 'no-cache' }); if (!r.ok) throw new Error(r.status); feed = await r.json(); }
  catch (e) { $('#boot').classList.add('gone'); $('#errorState').classList.remove('hidden'); return; }
  ITEMS = (feed.items || []).filter(it => it.mp4);
  BY_ID = {}; for (const it of ITEMS) BY_ID[it.id] = it;
  appendMore(5);
  placeInk(); paintSound();
  if (!slides.length) { onFirstFrame(); return; }
  activate(0);
  setTimeout(onFirstFrame, 1800); // never keep the skeleton up longer than this; the poster is already showing
  window.__aitok = { slides: () => slides, cur: () => cur, pool, P, activate, scrollToIndex, setMode, refreshFeed, openItem: (id) => openItem(BY_ID[id]), items: () => ITEMS };
}
$('#btnRetry').onclick = () => { $('#boot').classList.remove('gone'); boot(); };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
})();
