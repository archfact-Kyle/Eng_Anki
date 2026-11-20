import { Store } from './store.js';
import {
  DEFAULT_SETTINGS, Rating, State, makeNote, syncCards, buildQueues, pickNext, previewIntervals, answer,
  humanInterval, renderCloze, clozeAnswer, stripCloze, isCloze, splitSentences, dayKey, esc, wordDiff,
  parseDelimited, newCardState, uid, isLeechHit, trueRetention, endOfDay, slowThresholdMs,
  MATURE_DAYS, ANSWER_CAP_MS, reviewHistory, studyRate, estimateMs, fmtDuration, dueForecast, simulateLoad,
} from './core.js';
import { SAMPLE_SENTENCES, SAMPLE_CLOZES } from './samples.js';

const $ = (s, r = document) => r.querySelector(s);
const app = () => $('#view');
const store = new Store();
let settings = { ...DEFAULT_SETTINGS };
let view = 'home';
const sess = { item: null, side: 'front', count: 0, lastNote: null, typed: '', hint: 0, undo: null };
let browseQ = '', browseFilter = 'all', addMode = 'sent', mcdTokens = null, mcdSel = new Set();

// ---------------- helpers ----------------
function loadSettings() { settings = { ...DEFAULT_SETTINGS, ...(store.meta.settings || {}) }; }
function saveSettings(patch) { Object.assign(settings, patch); store.putMeta((m) => { m.settings = { ...settings }; }); }
function today() { const k = dayKey(settings); return store.meta.days[k] || { rv: 0, n: 0, ag: 0 }; }
function bumpToday(fn) { const k = dayKey(settings); store.putMeta((m) => { const d = m.days[k] || { rv: 0, n: 0, ag: 0 }; fn(d); m.days[k] = d; }); }
function toast(msg, actions = []) {
  const t = $('#toast'); t.innerHTML = '<span>' + esc(msg) + '</span>' + actions.map((a, i) => `<button data-ti="${i}">${esc(a.label)}</button>`).join('');
  t.classList.add('show');
  t.onclick = (e) => { const b = e.target.closest('button'); if (b) { actions[+b.dataset.ti].fn(); t.classList.remove('show'); } };
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), actions.length ? 7000 : 2600);
}
function modal(html, onMount) {
  const m = $('#modal'); m.innerHTML = '<div class="sheet">' + html + '</div>'; m.classList.add('show');
  m.onclick = (e) => { if (e.target === m) closeModal(); };
  onMount && onMount(m.firstChild);
}
function closeModal() { $('#modal').classList.remove('show'); $('#modal').innerHTML = ''; }
function confirmBox(text, okLabel, fn, danger) {
  modal(`<p class="mtext">${esc(text)}</p><div class="row end"><button class="btn ghost" data-x>취소</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button></div>`, (el) => {
    el.querySelector('[data-x]').onclick = closeModal;
    el.querySelector('[data-ok]').onclick = () => { closeModal(); fn(); };
  });
}

// ---------------- app refresh (iPhone home-screen apps have no reload button / pull-to-refresh) ----------------
/* global __APP_VERSION__ */
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const verLabel = (v) => (v && /-v(\d+)$/.test(v)) ? 'v' + v.match(/-v(\d+)$/)[1] : (v || '–');
const upd = { latest: null, checked: false, busy: false };
async function checkUpdate() {
  if (window.claude || !/^https?:$/.test(location.protocol)) return null;   // artifact: no version file to compare
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    upd.latest = (await r.json()).v || null;
  } catch (e) { /* offline → keep what we know */ }
  upd.checked = true; return upd.latest;
}
const hasUpdate = () => !!(upd.latest && upd.latest !== APP_VERSION && APP_VERSION !== 'dev');
async function appRefresh() {
  if (upd.busy) return; upd.busy = true;
  toast('앱을 새로 불러오는 중… (카드와 기록은 그대로예요)');
  // 1) save anything still waiting in the 250 ms write buffer, so no review is lost
  try { clearTimeout(store._localTimer); await store.flushLocal(); } catch (e) {}
  try { if (store.cloudStatus === 'on') { clearTimeout(store._cloudTimer); await store.flushCloud(); } } catch (e) {}
  // 2) drop the offline copy of the app files (only app files — IndexedDB data is untouched)
  try { if ('serviceWorker' in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map((r) => r.unregister())); } } catch (e) {}
  try { if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.filter((k) => k.startsWith('ankiwords')).map((k) => caches.delete(k))); } } catch (e) {}
  // 3) reload from the network; a fresh query string also skips Safari's HTTP cache
  if (window.claude) return location.reload();
  const u = new URL(location.href); u.searchParams.set('r', Date.now().toString(36)); location.replace(u.toString());
}

// ---------------- TTS ----------------
// iOS/macOS ship joke & robotic voices tagged en-US (Albert, Bubbles, Zarvox, Eloquence voices …).
// Picking "the first en-US voice" often lands on one of them → rank voices by quality instead.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Junior|Kathy|Organ|Pipe Organ|Princess|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley|Fred)\b/i;
const GOOD_NAMES = /\b(Ava|Zoe|Evan|Nathan|Allison|Samantha|Susan|Tom|Joelle|Noelle|Nicky|Aaron|Serena|Daniel|Kate|Oliver|Karen|Lee|Moira|Tessa|Jenny|Aria|Guy|Michelle|Emma|Brian|Andrew|Libby|Sonia|Ryan|Natasha|William)\b/i;
function voiceTier(v) {
  const id = v.name + ' ' + v.voiceURI;
  if (NOVELTY.test(v.name) || /eloquence|speech\.synthesis\.voice\.(Albert|Bad|Bahh|Bells|Boing|Bubbles|Cellos|Good|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)/i.test(id)) return -1;
  if (/premium/i.test(id)) return 4;
  if (/enhanced|neural|natural|online/i.test(id)) return 3;
  if (/google/i.test(id)) return 2;
  if (GOOD_NAMES.test(v.name)) return 1;
  return 0;
}
function voiceScore(v) {
  const accent = settings.ttsAccent || 'en-US';
  const lang = (v.lang || '').replace('_', '-');
  return voiceTier(v) * 100 + (lang === accent ? 500 : /^en-(US|GB)$/.test(lang) ? 8 : 0) + (GOOD_NAMES.test(v.name) ? 5 : 0);
}
let voices = [];
function loadVoices() {
  try { voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)).sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name)); } catch (e) { voices = []; }
}
function pickVoice() {
  const chosen = settings.ttsVoice && voices.find((x) => x.voiceURI === settings.ttsVoice);
  if (chosen) return chosen;
  return voices.find((v) => voiceTier(v) >= 0) || null;
}
const ACCENTS = { 'en-US': '미국', 'en-GB': '영국', 'en-AU': '호주', 'en-IE': '아일랜드', 'en-ZA': '남아공', 'en-IN': '인도', 'en-CA': '캐나다' };
const TIER_LABEL = ['', '', '', '고음질', '최고음질'];
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = () => { loadVoices(); if (view === 'settings') render(true); }; }
let claudeTTS = null;
function speak(text, voiceOverride) {
  text = stripCloze(text || '').replace(/\s+/g, ' ').trim(); if (!text) return;
  if ('speechSynthesis' in window) {
    if (!voices.length) loadVoices();
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = voiceOverride || pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = settings.ttsAccent || 'en-US';
      u.rate = settings.ttsRate; u.pitch = 1;
      speechSynthesis.speak(u); return;
    } catch (e) {}
  }
  if (claudeTTS) claudeTTS.speak(text, { language: 'en', rate: Math.min(1.5, Math.max(0.7, settings.ttsRate)) }).catch(() => {});
}

// ---------------- stats ----------------
function counts() {
  const q = buildQueues(store.liveNotes(), settings, today());
  return { learn: q.learn.length + q.laterLearn.length, review: q.review.length, fresh: q.fresh.length, freshTotal: q.freshTotal, q };
}
function sentenceCount() {
  let n = 0; for (const note of store.liveNotes()) n += note.type === 'cloze' ? Math.max(1, splitSentences(stripCloze(note.text)).length) : 1; return n;
}
function streak() {
  let s = 0; const now = Date.now();
  for (let i = 0; i < 3650; i++) {
    const k = dayKey(settings, now - i * 86400e3); const d = store.meta.days[k];
    if (d && d.rv > 0) s++; else if (i === 0) continue; else break;
  }
  return s;
}
function forecast(days = 7) { return dueForecast(store.liveNotes(), settings, days).days.map((d) => d.review + d.learn); }

// ---------------- render ----------------
function render(keepScroll) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
  const y = window.scrollY;
  ({ home: renderHome, review: renderReview, add: renderAdd, browse: renderBrowse, settings: renderSettings, stats: renderStats })[view]();
  window.scrollTo(0, keepScroll ? y : 0);
}
function go(v) { view = v; if (v === 'review') { sess.item = null; } render(); }

function cloudBadge() {
  const s = store.cloudStatus;
  if (s === 'on') return '<span class="badge ok">☁ 기기 간 동기화 중</span>';
  if (s === 'connecting') return '<span class="badge">☁ 연결 중…</span>';
  if (s === 'error') return '<span class="badge warn">☁ 동기화 오류 · 이 기기에만 저장</span>';
  return `<span class="badge">💾 이 기기에 저장 (${store.local.mode})</span>`;
}

function renderHome() {
  const c = counts(); const t = today(); const total = sentenceCount(); const goal = 10000;
  const empty = store.liveNotes().length === 0;
  const days = []; for (let i = 13; i >= 0; i--) { const k = dayKey(settings, Date.now() - i * 86400e3); days.push({ k, v: (store.meta.days[k] || {}).rv || 0 }); }
  const maxD = Math.max(10, ...days.map((d) => d.v));
  const fc = forecast(7); const maxF = Math.max(10, ...fc);
  const tr = trueRetention(store.meta.days, settings);
  const sr = studyRate(store.meta.days, settings, 30);
  const left = c.fresh + c.learn + c.review;
  const est = left ? estimateMs(left, store.meta.days, settings) : null;
  const trNote = tr.count < 30 ? '<p class="small muted">실제 기억률은 복습 단계 카드가 30번 이상 쌓이면 판단할 수 있어요 (목표 75~90%).</p>'
    : tr.rate < 0.7 ? '<p class="note warn">기억률이 70% 미만이에요 → 설정에서 목표 기억률을 올리거나, 리치를 정리하고 더 쉬운 예문으로 바꾸세요.</p>'
    : tr.rate > 0.9 ? '<p class="note">기억률이 90%를 넘어요 → 너무 자주 복습 중입니다. 목표 기억률을 낮추면 복습량이 줄어요.</p>'
    : '<p class="small muted">적정 범위(75~90%)예요. 지금처럼 매일 하세요.</p>';
  app().innerHTML = `
  <header class="hero"><h1>영어 문장 Anki</h1><p class="sub">AJATT · MCD · Antimoon 방식 · FSRS 복습</p>${cloudBadge()}</header>
  ${hasUpdate() ? `<section class="card remind" id="update-banner"><b>🔄 새 버전이 있어요</b><p class="small muted">${verLabel(APP_VERSION)} → ${verLabel(upd.latest)}. 카드와 복습 기록은 그대로 두고 앱 화면만 새로 받아요.</p><button class="btn primary" data-act="app-refresh">지금 새로고침</button></section>` : ''}
  ${empty ? `<section class="card empty"><h2>첫 문장을 넣어볼까요?</h2><p>AJATT의 핵심은 <b>단어가 아닌 문장</b>을 모으는 것, Antimoon의 핵심은 <b>검증된 예문</b>을 입력하는 것입니다.</p>
    <div class="row"><button class="btn primary" data-act="sample">예제 덱 불러오기</button><button class="btn" data-go="add">직접 추가</button></div></section>` : ''}
  ${!empty && store.cloudStatus !== 'on' && Date.now() - (store.meta.lastBackup || 0) > 7 * 86400e3 ? `<section class="card remind"><b>💾 백업할 때가 됐어요</b><p class="small muted">카드가 이 기기에만 저장돼 있어요. ${store.meta.lastBackup ? '마지막 백업 ' + Math.floor((Date.now() - store.meta.lastBackup) / 86400e3) + '일 전.' : '아직 백업한 적이 없어요.'}</p><button class="btn" data-act="exp-json">지금 백업</button></section>` : ''}
  <section class="card due">
    <div class="nums"><div><b class="blue">${c.fresh}</b><span>새 카드</span></div><div><b class="red">${c.learn}</b><span>학습 중</span></div><div><b class="green">${c.review}</b><span>복습</span></div></div>
    <button class="btn primary big" data-go="review" ${c.fresh + c.learn + c.review ? '' : 'disabled'}>${c.fresh + c.learn + c.review ? '복습 시작' : '오늘 할 카드 완료 🎉'}</button>
    ${est ? `<p class="small est">⏱ 예상 약 ${fmtDuration(Math.max(60e3, est.ms))}${est.measured ? ` · 내 평균 ${(est.per / 1000).toFixed(1)}초/장` : ' (기록이 쌓이면 내 속도로 계산해요)'}</p>` : ''}
    <p class="muted small">오늘 ${t.rv}장 복습 · 새 카드 ${t.n}/${settings.newPerDay} · 대기 중인 새 카드 ${c.freshTotal}장</p>
    ${c.q.backlog ? `<p class="note warn">📦 밀린 카드 ${c.q.overdue}장 — 기억할 가능성이 높은 순서로 하루 ${settings.maxReviews}장까지만 보여드려요. 매일 조금씩 줄이면 됩니다.</p>` : ''}
    ${c.q.learnFlood ? `<p class="note warn">⏸ 학습 중인 카드가 ${c.learn}장(${settings.learnCap}장 이상)이라 새 카드를 잠시 멈췄어요.</p>` : ''}
  </section>
  <section class="card">
    <div class="row between"><h3>1만 문장 목표</h3><span class="muted">${total.toLocaleString()} / ${goal.toLocaleString()}</span></div>
    <div class="bar"><i style="width:${Math.min(100, total / goal * 100).toFixed(2)}%"></i></div>
    <div class="row between small muted"><span>📅 학습한 날 ${sr.studied}/${sr.period}일 · 🔥 연속 ${streak()}일</span><span>실제 기억률(30일) ${tr.rate == null ? '–' : Math.round(tr.rate * 100) + '%'}</span></div>
    ${trNote}
  </section>
  <section class="card"><div class="row between"><h3>최근 14일 복습</h3><button class="link" data-go="stats">📊 통계 자세히</button></div><div class="spark">${days.map((d) => `<i title="${d.k}: ${d.v}" style="height:${(d.v / maxD * 100).toFixed(0)}%"></i>`).join('')}</div></section>
  <section class="card"><h3>앞으로 7일 예정</h3><div class="spark f">${fc.map((v, i) => `<div><i style="height:${(v / maxF * 100).toFixed(0)}%"></i><small>${i === 0 ? '오늘' : '+' + i}</small><small>${v}</small></div>`).join('')}</div></section>
  <details class="card guide"><summary>학습법 안내 (AJATT · MCD · Antimoon)</summary>
    <ol>
      <li><b>문장 단위로 모으기 (AJATT 1만 문장)</b> — 단어장 대신, 읽거나 들은 영어 중 "모르는 것이 딱 하나"인 문장을 넣으세요. i+1 문장이 가장 잘 남습니다.</li>
      <li><b>MCD (대량 맥락 클로즈)</b> — 좋아하는 글의 한 문단을 통째로 붙여넣고 외울 단어만 탭해서 가리세요. 문단 하나에서 여러 장의 카드가 생깁니다. 복습할 때는 <u>가려진 문장에만 집중</u>하고 나머지는 맥락으로 훑으세요.</li>
      <li><b>새 문장은 먼저 노출</b> — 처음엔 답과 함께 듣고 읽고, 1분·10분 뒤 다시 보며 익힙니다. 이미 아는 문장은 보류하세요.</li>
      <li><b>채점은 두 버튼</b> — 목표 표현을 문맥 속에서 이해하면 <b>알맞음</b>, 아니면 <b>다시</b>. 떠올렸지만 느렸다면 앱이 자동으로 <b>어려움</b>으로 기록해 더 자주 보여줍니다(속도 채점). 어려움·쉬움은 간격을 비틀고 고민만 늘립니다. 확실하면 답을 보지 않고 앞면에서 바로 채점하세요. 소리 내어 읽기는 중급 이후 선택 (ajatt.top).</li>
      <li><b>매일, 조금씩</b> — 하루 빠지면 다음 날 복습이 약 2배. 새 카드는 하루 30장 이하, 실제 기억률 75~90%가 정상입니다. 매번 몇 장씩 잊는 게 맞아요.</li>
      <li><b>안 되는 카드는 보류</b> — 5번 잊으면 리치로 자동 보류, 같은 날 3번 틀리면 내일로. 다른 예문으로 바꾸거나 실력이 오른 뒤 다시 켜세요. 간격이 10년을 넘으면 은퇴.</li>
      <li><b>예문이 정의보다 중요 (Antimoon)</b> — 사전의 예문을 그대로 넣으세요. 뜻뿐 아니라 전치사·어순·연어(collocation)가 함께 들어옵니다.</li>
      <li><b>실수 줄이기 (Antimoon)</b> — 한→영 산출 카드는 <u>본 적 있는 문장</u>으로만 만드세요. 써본 답과 정답이 단어 단위로 비교되어 틀린 부분이 표시됩니다.</li>
      <li><b>인풋이 먼저</b> — 카드는 보조입니다. 하루 대부분은 읽기·듣기, Anki는 그중 건진 문장을 붙잡아 두는 도구입니다.</li>
    </ol>
  </details>`;
}

// ----- stats (Anki "Reviews" graph: count or time, 1m / 3m / 1y / all) -----
let statsMode = 'count', statsRange = 30;
function statsChart(h, time) {
  const W = 320, H = 150, bw = W / h.buckets.length, gap = bw > 4 ? 1 : 0;
  const val = (b) => time ? b.ms : b.rv;
  const max = Math.max(time ? 60e3 : 5, ...h.buckets.map(val));
  const cumMax = Math.max(1, time ? h.totalMs : h.total);
  let rects = '';
  h.buckets.forEach((b, i) => {
    const x = (i * bw).toFixed(2), w = Math.max(0.5, bw - gap).toFixed(2);
    const tip = `${b.start}${h.bucketDays > 1 ? ' 부터 ' + h.bucketDays + '일' : ''}: ${b.rv}장 · ${fmtDuration(b.ms)}`;
    let y = H;
    // time is stored per day, not per colour → split the bar in the same proportions as the counts
    const segs = [['mt', 'mat'], ['young', 'yng'], ['ag', 'rel'], ['n', 'lrn']];
    rects += `<g><title>${esc(tip)}</title>`;
    for (const [k, cls] of segs) {
      if (!b[k]) continue;
      const part = time ? (b.rv ? b.ms * b[k] / b.rv : 0) : b[k];
      const hh = part / max * H; if (hh <= 0) continue;
      y -= hh; rects += `<rect class="${cls}" x="${x}" y="${y.toFixed(2)}" width="${w}" height="${hh.toFixed(2)}"/>`;
    }
    rects += '</g>';
  });
  const pts = [`0,${H}`, ...h.buckets.map((b, i) => `${((i + 1) * bw).toFixed(2)},${(H - (time ? b.cumMs : b.cum) / cumMax * H).toFixed(2)}`)];
  const fmt = (v) => time ? fmtDuration(v) : Math.round(v).toLocaleString();
  const startLbl = h.buckets[0].start.slice(5).replace('-', '/');
  return `<div class="chart">
    <div class="axis"><span>${fmt(max)}</span><span class="cumv">누적 ${fmt(cumMax)}</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${time ? '복습 시간' : '복습 횟수'} 그래프">
      <polygon class="cum" points="${pts.join(' ')} ${W},${H}"/>${rects}
    </svg>
    <div class="axis"><span>${startLbl}</span><span>오늘</span></div>
  </div>`;
}
// ----- workload forecast: real due dates (30 days) + FSRS simulation (1 year) -----
let simNew = null; const simCache = { key: '', res: null };
function barSvg(vals, cls, H = 110) {
  const W = 320, bw = W / vals.length, gap = bw > 4 ? 1 : 0, max = Math.max(5, ...vals.map((v) => v.reduce((a, b) => a + b, 0)));
  let s = '';
  vals.forEach((parts, i) => { let y = H; parts.forEach((v, j) => { const hh = v / max * H; if (hh <= 0) return; y -= hh; s += `<rect class="${cls[j]}" x="${(i * bw).toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0.5, bw - gap).toFixed(2)}" height="${hh.toFixed(2)}"/>`; }); });
  return { svg: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">${s}</svg>`, max };
}
function forecastSection() {
  const notes = store.liveNotes();
  const fc = dueForecast(notes, settings, 30);
  const tot = fc.days.map((d) => d.review + d.learn);
  const sum7 = tot.slice(0, 7).reduce((a, b) => a + b, 0), avg30 = tot.reduce((a, b) => a + b, 0) / 30;
  const per = estimateMs(1, store.meta.days, settings).per;
  const b1 = barSvg(fc.days.map((d) => [d.review, d.learn]), ['mat', 'rel']);
  const npd = simNew == null ? settings.newPerDay : simNew;
  const choices = [...new Set([0, 10, settings.newPerDay, 30])].sort((a, b) => a - b);
  const key = [notes.length, store.meta.u || 0, npd, settings.retention, settings.maxReviews, settings.retireYears, dayKey(settings)].join('|');
  if (simCache.key !== key) { simCache.key = key; simCache.res = simulateLoad(notes, settings, { days: 365, newPerDay: npd }); }
  const sim = simCache.res;
  const weeks = []; for (let w = 0; w < 52; w++) { const s = sim.days.slice(w * 7, w * 7 + 7); weeks.push([s.reduce((a, x) => a + x.rv, 0) / s.length]); }
  const b2 = barSvg(weeks, ['pri']);
  const line = (label, v) => `<dt>${label}</dt><dd>${Math.round(v)}장/일 · 약 ${fmtDuration(v * per)}</dd>`;
  return `<section class="card" id="forecast">
    <h3>앞으로 30일 예정</h3>
    ${tot.some((v) => v) ? `<div class="chart"><div class="axis"><span>${b1.max}</span><span></span></div>${b1.svg}<div class="axis"><span>오늘</span><span>+29일</span></div></div>
    <div class="legend small"><span><i class="mat"></i>복습</span><span><i class="rel"></i>학습 중</span></div>` : '<p class="small muted">앞으로 30일 동안 예정된 복습이 없어요.</p>'}
    <dl class="kv"><dt>오늘</dt><dd>${tot[0]}장${fc.overdue ? ` (밀린 ${fc.overdue}장 포함)` : ''}</dd><dt>내일</dt><dd>${tot[1]}장</dd><dt>7일 합계</dt><dd>${sum7}장</dd><dt>30일 평균</dt><dd>${Math.round(avg30)}장/일</dd></dl>
    <p class="small muted">지금 있는 카드만 센 거예요. 새 카드를 넣으면 늘어납니다.</p>
  </section>
  <section class="card">
    <h3>1년 복습량 예측</h3>
    <p class="small muted">새 문장을 하루 몇 장씩 넣을 때를 가정할까요?</p>
    <div class="seg">${choices.map((c) => `<button data-sn="${c}" class="${c === npd ? 'on' : ''}">${c}장${c === settings.newPerDay ? '·현재' : ''}</button>`).join('')}</div>
    <div class="chart"><div class="axis"><span>${Math.round(b2.max)}장/일</span><span>주 평균</span></div>${b2.svg}<div class="axis"><span>이번 주</span><span>6개월</span><span>1년 뒤</span></div></div>
    <dl class="kv" id="sim-kv">${line('첫 주', sim.first)}${line('1개월 뒤', sim.m1)}${line('3개월 뒤', sim.m3)}${line('1년 뒤', sim.y1)}</dl>
    <p class="small muted">망각곡선(FSRS)으로 계산했어요. 카드마다 기억률이 목표 ${Math.round(settings.retention * 100)}%로 떨어질 때 복습이 잡히고, 그때 기억률만큼의 확률로 맞힌다고 가정합니다. 하루 ${settings.maxReviews}장을 넘으면 다음 날로 넘어가요. 오래 복습한 카드는 간격이 길어져서, 새 카드를 꾸준히 넣어도 하루 복습량은 대략 <b>새 카드 수 × 10장</b> 근처에서 완만해집니다. 시간은 내 평균 답변 속도(${(per / 1000).toFixed(1)}초/장) 기준이에요.</p>
  </section>`;
}
function renderStats() {
  const days = store.meta.days || {};
  const h = reviewHistory(days, settings, statsRange);
  const time = statsMode === 'time';
  const pct = (h.studied / h.period * 100).toFixed(1);
  const sr30 = studyRate(days, settings, 30);
  const rows = time ? [
    ['총 시간', fmtDuration(h.totalMs)],
    ['학습한 날 평균', h.timedDays ? fmtDuration(h.msStudied) + '/일' : '–'],
    ['전체 기간 평균', fmtDuration(h.msPeriod) + '/일'],
    ['평균 답변 시간', h.avgAnswerMs == null ? '–' : `${(h.avgAnswerMs / 1000).toFixed(2)}초 (분당 ${(60e3 / h.avgAnswerMs).toFixed(1)}장)`],
  ] : [
    ['합계', h.total.toLocaleString() + '장'],
    ['학습한 날 평균', Math.round(h.avgStudied) + '장/일'],
    ['전체 기간 평균', Math.round(h.avgPeriod) + '장/일'],
  ];
  const timeNote = time && h.timedDays < h.studied ? `<p class="small muted">답변 시간은 이번 업데이트 이후 복습부터 기록돼요. 그 전 ${h.studied - h.timedDays}일은 0으로 보입니다.</p>` : '';
  const rateMsg = sr30.rate >= 0.9 ? '아주 꾸준해요.' : sr30.rate >= 0.7 ? '충분히 꾸준해요. 13년 동안 111만 번 복습한 사람도 학습한 날은 79%였어요.' : '빠진 날이 많아요. 하루 몇 장이라도 열어 보면 밀린 카드가 덜 쌓여요.';
  app().innerHTML = `
  <header class="hero"><h1>통계</h1><p class="sub">답한 카드 수와 걸린 시간</p></header>
  <section class="card">
    <div class="seg" data-seg="mode"><button data-sm="count" class="${time ? '' : 'on'}">횟수</button><button data-sm="time" class="${time ? 'on' : ''}">시간</button></div>
    <div class="seg"><button data-sr="30" class="${statsRange === 30 ? 'on' : ''}">1개월</button><button data-sr="90" class="${statsRange === 90 ? 'on' : ''}">3개월</button><button data-sr="365" class="${statsRange === 365 ? 'on' : ''}">1년</button><button data-sr="0" class="${statsRange === 0 ? 'on' : ''}">전체</button></div>
    ${statsChart(h, time)}
    <div class="legend small"><span><i class="lrn"></i>새 카드</span><span><i class="rel"></i>다시</span><span><i class="yng"></i>어린 카드</span><span><i class="mat"></i>성숙 카드(간격 ${MATURE_DAYS}일+)</span></div>
    <dl class="kv" id="stats-kv"><dt>학습한 날</dt><dd>${h.studied.toLocaleString()} / ${h.period.toLocaleString()}일 (${pct}%)</dd>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${timeNote}
  </section>
  ${forecastSection()}
  <section class="card">
    <h3>꾸준함</h3>
    <p class="small">최근 30일 중 <b>${sr30.studied}일</b> 학습 (${Math.round(sr30.rate * 100)}%) · 🔥 연속 ${streak()}일</p>
    <p class="small muted">${rateMsg} 연속 기록이 끊겨도 괜찮아요. 오래 보면 <b>학습한 날 비율</b>이 더 중요합니다.</p>
  </section>
  <section class="card">
    <h3>그래프 읽는 법</h3>
    <p class="small muted">성숙 카드(진한 초록)가 늘수록 망각곡선이 완만해진 문장이 많다는 뜻이에요. 그런 카드는 몇 주~몇 달 간격으로만 나와서, 덱이 커져도 하루 복습량은 일정한 선에서 멈춥니다. 빨간 부분(다시)이 전체의 10~25%면 정상이에요.</p>
  </section>
  <button class="btn" data-go="home">← 홈으로</button>`;
}

// ----- review -----
function currentQueue() { return buildQueues(store.liveNotes(), settings, today()); }
function nextCard() {
  const q = currentQueue();
  sess.item = pickNext(q, settings, sess.count, sess.lastNote);
  sess.side = 'front'; sess.typed = ''; sess.hint = 0; sess.revealMs = null;
  sess.q = q; resetTimer();
}
// ----- answer timer (pauses while the app is in the background) -----
function resetTimer() { sess.shownAt = Date.now(); sess.hiddenMs = 0; sess.hiddenAt = document.hidden ? Date.now() : null; }
function elapsedMs() { const hid = sess.hiddenMs + (sess.hiddenAt ? Date.now() - sess.hiddenAt : 0); return Date.now() - (sess.shownAt || Date.now()) - hid; }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sess.hiddenAt = Date.now();
  else if (sess.hiddenAt) { sess.hiddenMs += Date.now() - sess.hiddenAt; sess.hiddenAt = null; }
});
function slowInfo(it, ms) {
  if (!settings.speedGrade || !settings.passFail || !it || it.card.st !== State.Review) return null;
  const thr = slowThresholdMs(it.key, settings); if (thr == null || ms <= thr) return null;
  return { sec: Math.round(ms / 100) / 10, thr: thr / 1000 };
}
function isIntro(it) { return settings.introNew && it && it.card.st === State.New && !it.card.iv && it.key !== 'prod'; }
function introduce(known) {
  const it = sess.item; if (!it) return;
  const note = store.notes.get(it.note.id); const prev = note.cards[it.key];
  const next = { ...prev };
  if (known) next.sus = 'known'; else { next.iv = Date.now(); next.due = Date.now() + 60e3; }
  sess.undo = { id: note.id, key: it.key, prev: { ...prev }, day: dayKey(settings), wasNew: !known, intro: true };
  note.cards[it.key] = next; store.putNote(note);
  if (!known) bumpToday((d) => { d.n++; });
  sess.lastNote = note.id; sess.item = null; render();
  if (known) toast('이미 아는 문장은 보류했어요 (목록 → 보류에서 되살릴 수 있어요)');
}
function cardFace(item, side) {
  const { note, key } = item;
  const ko = note.ko ? `<div class="ko">${esc(note.ko)}</div>` : '';
  const extra = note.extra ? `<div class="extra">${esc(note.extra).replace(/\n/g, '<br>')}</div>` : '';
  const src = note.src ? `<div class="src">— ${esc(note.src)}</div>` : '';
  const say = (t) => `<button class="say" data-say="${esc(t)}" aria-label="발음 듣기">🔊</button>`;
  if (key.startsWith('c')) {
    const n = +key.slice(1); const r = renderCloze(note.text, n, side);
    sess.speakText = r.targetSentence;
    return `<div class="kind">MCD 클로즈 · c${n}</div><div class="para">${r.html}</div>${side === 'back' ? `<div class="ans">${say(r.targetSentence)} <b>${esc(clozeAnswer(note.text, n))}</b></div>${ko}${extra}${src}` : ''}`;
  }
  if (key === 'prod') {
    sess.speakText = note.text;
    const words = note.text.split(/\s+/);
    const hint = sess.hint ? `<div class="hint">${esc(words.map((w) => w.replace(/^([^A-Za-z]*[A-Za-z])[A-Za-z'’-]*/, '$1_')).join(' '))}</div>` : '';
    if (side === 'front') return `<div class="kind">한 → 영 산출</div><div class="ko big">${esc(note.ko)}</div>${hint}
      <textarea id="typed" rows="3" placeholder="영어로 써보세요 (선택) — 본 적 있는 표현으로" autocapitalize="sentences">${esc(sess.typed)}</textarea>
      ${sess.hint ? '' : '<button class="link" data-act="hint">첫 글자 힌트</button>'}`;
    let diff = '';
    if (sess.typed.trim()) {
      const d = wordDiff(sess.typed, note.text);
      diff = `<div class="diff">${d.parts.map((p) => `<span class="${p.t}">${esc(p.w)}</span>`).join(' ')}</div><div class="muted small">${d.perfect ? '완벽해요 ✔' : '일치 ' + Math.round(d.score * 100) + '% — 빨간 줄은 빠진 말, 회색 취소선은 불필요한 말'}</div>`;
    }
    return `<div class="kind">한 → 영 산출</div><div class="ko big">${esc(note.ko)}</div>${diff}<div class="en">${say(note.text)} ${esc(note.text)}</div>${extra}${src}`;
  }
  sess.speakText = note.text;
  return `<div class="kind">문장 이해</div><div class="en big">${say(note.text)} ${esc(note.text)}</div>${side === 'back' ? ko + extra + src : ''}`;
}
// ----- pronunciation recorder (ajatt.top "built-in speech training"; recordings are temporary) -----
const rec = { mr: null, chunks: [], url: null, state: 'idle', off: false };
function recSupported() { return settings.recorder && !rec.off && !window.claude && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder; }
function recBar() {
  if (!recSupported()) return '';
  return `<div class="recbar" id="recbar"><button class="btn ghost ${rec.state === 'rec' ? 'recording' : ''}" data-act="rec">${rec.state === 'rec' ? '⏹ 정지' : '🎙 따라 말하기 녹음'}</button>${rec.url ? '<button class="btn ghost" data-act="rec-play">▶ 내 목소리</button>' : ''}</div>`;
}
function updateRecUI() { const b = $('#recbar'); if (b) b.outerHTML = recBar(); }
async function recToggle() {
  if (rec.state === 'rec') { try { rec.mr.stop(); } catch (e) {} return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    rec.chunks = []; const mr = new MediaRecorder(stream); rec.mr = mr;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (rec.url) URL.revokeObjectURL(rec.url);
      rec.url = rec.chunks.length ? URL.createObjectURL(new Blob(rec.chunks, { type: mr.mimeType || 'audio/mp4' })) : null;
      rec.state = 'idle'; updateRecUI(); recPlay();
    };
    mr.start(); rec.state = 'rec'; updateRecUI();
  } catch (e) { rec.state = 'idle'; rec.off = true; updateRecUI(); toast('마이크를 쓸 수 없어 녹음 버튼을 숨겼어요'); }
}
function recPlay() { if (rec.url) { try { new Audio(rec.url).play().catch(() => {}); } catch (e) {} } }
function recClear() {
  if (rec.mr && rec.state === 'rec') { try { rec.mr.onstop = null; rec.mr.stop(); rec.mr.stream.getTracks().forEach((t) => t.stop()); } catch (e) {} }
  if (rec.url) URL.revokeObjectURL(rec.url); rec.url = null; rec.state = 'idle'; rec.mr = null;
}

function gradeButtons(prev, front) {
  const all = [[Rating.Again, '다시', 'again'], [Rating.Hard, '어려움', 'hard'], [Rating.Good, '알맞음', 'good'], [Rating.Easy, '쉬움', 'easy']];
  const use = settings.passFail || front ? all.filter(([r]) => r === Rating.Again || r === Rating.Good) : all;
  const slow = !front && slowInfo(sess.item, sess.revealMs || 0);
  return use.map(([r, l, cls]) => (slow && r === Rating.Good)
    ? `<button class="grade ${cls} slow" data-grade="${r}"><small>${humanInterval(prev[Rating.Hard])}</small>알맞음·느림</button>`
    : `<button class="grade ${cls}" data-grade="${r}"><small>${humanInterval(prev[r])}</small>${l}</button>`);
}
function renderReview() {
  if (!sess.item) { recClear(); nextCard(); }
  const it = sess.item;
  if (!it) {
    const later = (sess.q && sess.q.laterLearn.length) ? `<p class="muted">학습 중인 카드 ${sess.q.laterLearn.length}장은 ${humanInterval(sess.q.laterLearn[0].card.due - Date.now())} 뒤에 다시 나옵니다.</p>` : '';
    const left = sess.q && sess.q.reviewTotal > sess.q.review.length ? `<p class="muted small">밀린 카드 ${sess.q.reviewTotal - sess.q.review.length}장은 내일 이어서 보여드려요. 매일 조금씩 줄이면 됩니다.</p>` : '';
    app().innerHTML = `<section class="card center"><h2>오늘 할 카드를 모두 끝냈어요 🎉</h2>${later}${left}<p class="muted">AJATT: 남은 시간은 영어 인풋(읽기·듣기)으로 채우고, 거기서 건진 문장을 추가하세요.</p><div class="row center"><button class="btn" data-go="add">문장 추가</button><button class="btn ghost" data-go="home">홈</button></div></section>`;
    return;
  }
  const c = it.card; const q = sess.q;
  if (isIntro(it)) {
    app().innerHTML = `
  <div class="rtop"><span class="blue">${q.fresh.length}</span> · <span class="red">${q.learn.length + q.laterLearn.length}</span> · <span class="green">${q.review.length}</span>
    <span class="spacer"></span>${sess.undo ? '<button class="link" data-act="undo">↶ 되돌리기</button>' : ''}<button class="link" data-act="edit" data-id="${it.note.id}">편집</button></div>
  <section class="card face back intro"><div class="introbadge">✨ 새 문장 소개 — 맞히려 하지 말고 듣고 읽으며 익숙해지세요</div>${cardFace(it, 'back')}${recBar()}</section>
  <div class="check">1분·10분 뒤 다시 보며 익히고, 익숙해지면 내일로 넘어갑니다.</div>
  <div class="answer"><button class="btn ghost known" data-act="intro-known">이미 알아요</button><button class="btn primary show" data-act="intro-ok">익혔어요 → 학습 시작</button></div>`;
    if (settings.autoPlay) speak(sess.speakText);
    return;
  }
  const prev = previewIntervals(c, settings);
  const slowNote = sess.side === 'back' ? slowInfo(it, sess.revealMs || 0) : null;
  const leech = c.l >= settings.leechLapses;
  const front = sess.side === 'front';
  let answerRow;
  if (front) {
    answerRow = settings.frontGrade
      ? (() => { const [again, good] = gradeButtons(prev, true); return `${again}<button class="btn primary show" data-act="show">답 보기</button>${good}`; })()
      : '<button class="btn primary big" data-act="show">답 보기</button>';
  } else answerRow = gradeButtons(prev, false).join('');
  app().innerHTML = `
  <div class="rtop"><span class="blue">${q.fresh.length}</span> · <span class="red">${q.learn.length + q.laterLearn.length}</span> · <span class="green">${q.review.length}</span>
    <span class="spacer"></span>${sess.undo ? '<button class="link" data-act="undo">↶ 되돌리기</button>' : ''}<button class="link" data-act="edit" data-id="${it.note.id}">편집</button></div>
  <section class="card face ${sess.side}">${cardFace(it, sess.side)}${!front ? recBar() : ''}${leech ? '<div class="leech">자주 잊는 카드(리치)예요. 보류해 두고 나중에 보거나, 다른 예문으로 바꾸는 게 효율적입니다. <button class="link" data-act="edit" data-id="' + it.note.id + '">편집/보류</button></div>' : ''}</section>
  ${slowNote ? `<div class="check slowmsg">⏱ ${slowNote.sec}초 걸렸어요 (기준 ${slowNote.thr}초) → 알맞음은 <b>어려움</b>으로 기록돼 더 자주 나옵니다</div>` : ''}
  ${!front && settings.showChecklist ? '<div class="check">목표 표현을 문맥 속에서 이해했으면 <b>알맞음</b>, 아니면 <b>다시</b>. 자신 없다는 이유만으로 다시를 누르지 마세요.</div>' : ''}
  ${front && settings.frontGrade ? '<div class="check">확실히 알면 답을 보지 않고 바로 채점해도 됩니다.</div>' : ''}
  <div class="answer ${front && settings.frontGrade ? 'fg' : ''}">${answerRow}</div>`;
  if (settings.autoPlay && (!front || it.key === 'rec')) speak(sess.speakText);
}
function showAnswer() { const ta = $('#typed'); if (ta) sess.typed = ta.value; sess.revealMs = elapsedMs(); sess.side = 'back'; render(); }
function grade(r) {
  const it = sess.item; if (!it) return;
  if (settings.passFail && (r === Rating.Hard || r === Rating.Easy)) return;
  if (isIntro(it)) return introduce(false);
  const frontGraded = sess.side === 'front';
  const slow = r === Rating.Good ? slowInfo(it, frontGraded ? elapsedMs() : (sess.revealMs || 0)) : null;
  if (slow) r = Rating.Hard; // speed grading: recalled, but slowly → Hard (FSRS meaning of Hard)
  const note = store.notes.get(it.note.id); const prev = note.cards[it.key];
  const wasNew = prev.st === State.New && !prev.iv, wasReview = prev.st === State.Review;
  const tk = dayKey(settings); const again = r === Rating.Again;
  const next = answer(prev, r, settings);
  delete next.bury;
  if (again) { if (next.fd === tk) next.fc = (next.fc || 0) + 1; else { next.fd = tk; next.fc = 1; } }
  let msg = null;
  if (wasReview && again && isLeechHit(next.l, settings.leechLapses)) {
    next.sus = 'leech';
    msg = ['리치: ' + next.l + '번 잊어서 자동 보류했어요. 목록 → 리치에서 문장을 바꾸거나 나중에 다시 켜세요', [{ label: '보류 해제', fn: () => { const n = store.notes.get(note.id); if (n && n.cards[it.key]) { delete n.cards[it.key].sus; store.putNote(n); render(true); } } }]];
  } else if (again && settings.dayFailBury && next.fc >= settings.dayFailBury) {
    next.bury = endOfDay(settings);
    msg = ['오늘 ' + next.fc + '번 틀린 카드는 내일로 미뤘어요 (같은 날 반복은 장기 기억에 거의 도움이 안 돼요)', []];
  }
  if (!again && settings.retireYears && next.st === State.Review && next.sd >= settings.retireYears * 365) {
    next.sus = 'retired';
    msg = ['다음 복습이 ' + humanInterval(next.sd * 86400e3) + ' 뒤라 은퇴시켰어요 (복습량 관리)', [{ label: '취소', fn: () => { const n = store.notes.get(note.id); if (n && n.cards[it.key]) { delete n.cards[it.key].sus; store.putNote(n); } } }]];
  }
  // answer time (background time excluded, capped like Anki) and mature = interval before this review ≥ 21 days
  const ms = Math.min(ANSWER_CAP_MS, Math.max(0, Math.round(elapsedMs())));
  const mature = wasReview && !again && (prev.sd || 0) >= MATURE_DAYS;
  sess.undo = { id: note.id, key: it.key, prev: { ...prev }, day: tk, wasNew, wasReview, again, ms, mature };
  note.cards[it.key] = next;
  store.putNote(note);
  bumpToday((d) => { d.rv++; if (wasNew) d.n++; if (again) d.ag = (d.ag || 0) + 1; if (wasReview) { d.tr = (d.tr || 0) + 1; if (again) d.trf = (d.trf || 0) + 1; } d.ms = (d.ms || 0) + ms; d.tc = (d.tc || 0) + 1; if (mature) d.mt = (d.mt || 0) + 1; });
  sess.count++; sess.lastNote = note.id;
  sess.item = null; render();
  if (msg) toast(msg[0], msg[1]);
  else if (slow && frontGraded) toast(`⏱ ${slow.sec}초 — 느리게 떠올려서 '어려움'으로 기록했어요`);
}
function undo() {
  const u = sess.undo; if (!u) return; const note = store.notes.get(u.id); if (!note || !note.cards[u.key]) return;
  note.cards[u.key] = u.prev; store.putNote(note);
  if (u.intro) store.putMeta((m) => { const d = m.days[u.day]; if (d && u.wasNew) d.n = Math.max(0, d.n - 1); });
  else store.putMeta((m) => { const d = m.days[u.day]; if (d) { d.rv = Math.max(0, d.rv - 1); if (u.wasNew) d.n = Math.max(0, d.n - 1); if (u.again) d.ag = Math.max(0, (d.ag || 0) - 1); if (u.wasReview) { d.tr = Math.max(0, (d.tr || 0) - 1); if (u.again) d.trf = Math.max(0, (d.trf || 0) - 1); } if (u.ms != null && d.tc) { d.ms = Math.max(0, (d.ms || 0) - u.ms); d.tc--; } if (u.mature && d.mt) d.mt--; } });
  sess.undo = null; sess.count = Math.max(0, sess.count - 1);
  const q = currentQueue(); const all = [...q.learn, ...q.review, ...q.fresh, ...q.laterLearn];
  sess.item = all.find((x) => x.note.id === u.id && x.key === u.key) || null; sess.q = q; sess.side = 'front'; sess.typed = '';
  recClear(); render();
}

// ----- add -----
function tokenize(text) { return text.split(/(\s+)/).filter((t) => t.length); }
function buildClozeFromTokens() {
  // consecutive selected word tokens (ignoring whitespace) form one cloze
  let out = '', n = 0, open = false; const toks = mcdTokens;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]; const ws = /^\s+$/.test(t);
    if (ws) {
      // whitespace: keep inside cloze only if the next word is also selected
      let j = i + 1; const nextSel = j < toks.length && mcdSel.has(j);
      if (open && !nextSel) { out += '}}'; open = false; }
      out += t; continue;
    }
    if (mcdSel.has(i)) {
      const m = t.match(/^([^A-Za-z0-9]*)([\s\S]*?)([^A-Za-z0-9']*)$/);
      const [, pre, core, post] = m;
      if (!open) { out += pre + '{{c' + (++n) + '::' + core; open = true; } else out += pre + core;
      const nextSel = mcdSel.has(i + 2) && /^\s+$/.test(toks[i + 1] || '') && !post;
      if (!nextSel) { out += '}}' + post; open = false; } else out += post;
    } else out += t;
  }
  if (open) out += '}}';
  return { text: out, n };
}
function renderAdd() {
  const seg = [['sent', '문장'], ['mcd', 'MCD 문단'], ['bulk', '일괄 가져오기']].map(([k, l]) => `<button class="${addMode === k ? 'on' : ''}" data-mode="${k}">${l}</button>`).join('');
  let body = '';
  if (addMode === 'sent') body = `
    <label>영어 문장 *<textarea id="f-en" rows="3" placeholder="예) I ran out of time, so I had to skip lunch."></textarea></label>
    <p class="tip">💡 사전의 예문이나 실제로 읽고 들은 문장을 그대로 넣으세요 (Antimoon). 모르는 것이 하나뿐인 문장이 이상적입니다 (AJATT).</p>
    <label>한국어 뜻<textarea id="f-ko" rows="2" placeholder="자연스러운 해석"></textarea></label>
    <label>메모 (영영 정의·연어·문법)<textarea id="f-ex" rows="2" placeholder="run out of ~ : ~이 다 떨어지다"></textarea></label>
    <label>출처<input id="f-src" placeholder="책, 영상, 사전 이름 등"></label>
    <label class="chk"><input type="checkbox" id="f-prod" ${settings.prodDefault ? 'checked' : ''}> 한→영 산출 카드도 만들기 (한국어 뜻 필요)</label>
    <button class="btn primary big" data-act="add-sent">추가</button>`;
  else if (addMode === 'mcd') {
    if (!mcdTokens) body = `
      <label>영어 문단 붙여넣기 *<textarea id="m-text" rows="7" placeholder="좋아하는 책·기사·자막에서 한 문단을 그대로 붙여넣으세요."></textarea></label>
      <p class="tip">💡 다음 단계에서 외울 단어를 탭해 가립니다. 붙어 있는 단어를 연달아 탭하면 하나의 구(phrase)로 묶여요. 이미 {{c1::...}} 형식이면 바로 저장됩니다.</p>
      <button class="btn primary big" data-act="mcd-next">단어 고르기 →</button>`;
    else {
      const { n } = buildClozeFromTokens();
      body = `<p class="muted small">외울 단어를 탭하세요 · 선택 ${n}개 → 카드 ${n}장</p>
      <div class="chips">${mcdTokens.map((t, i) => /^\s+$/.test(t) ? (t.includes('\n') ? '<br>' : ' ') : (/[A-Za-z0-9]/.test(t) ? `<span class="chip ${mcdSel.has(i) ? 'sel' : ''}" data-tok="${i}">${esc(t)}</span>` : `<span class="punc">${esc(t)}</span>`)).join('')}</div>
      <label>한국어 해석 (선택)<textarea id="m-ko" rows="3"></textarea></label>
      <label>Extra (정의·예문·문법 메모)<textarea id="m-ex" rows="2"></textarea></label>
      <label>출처<input id="m-src"></label>
      <div class="row"><button class="btn ghost" data-act="mcd-back">← 문단 수정</button><button class="btn primary" data-act="add-mcd" ${n ? '' : 'disabled'}>카드 ${n}장 만들기</button></div>`;
    }
  } else body = `
    <p class="tip">한 줄에 한 카드: <code>영어 ⇥ 한국어 ⇥ 메모 ⇥ 출처</code> (탭 또는 쉼표 구분 CSV). 영어 칸에 <code>{{c1::단어}}</code>가 있으면 MCD 클로즈로 만들어집니다. Anki에서 내보낸 텍스트도 그대로 됩니다.</p>
    <label>파일 선택 (.txt .csv .tsv)<input type="file" id="b-file"></label>
    <label>또는 붙여넣기<textarea id="b-text" rows="8" placeholder="I'm looking forward to it.	정말 기대돼요.	look forward to + -ing"></textarea></label>
    <label class="chk"><input type="checkbox" id="b-prod" ${settings.prodDefault ? 'checked' : ''}> 한→영 산출 카드도 만들기</label>
    <label class="chk"><input type="checkbox" id="b-head"> 첫 줄은 제목 행 (건너뛰기)</label>
    <button class="btn primary big" data-act="bulk">가져오기</button>`;
  app().innerHTML = `<h2 class="title">카드 추가</h2><div class="seg">${seg}</div><section class="card form">${body}</section>`;
}
function addSentence() {
  const en = $('#f-en').value.trim(); if (!en) return toast('영어 문장을 입력하세요');
  const note = makeNote({ text: en, ko: $('#f-ko').value, extra: $('#f-ex').value, src: $('#f-src').value, prod: $('#f-prod').checked }, settings);
  if ($('#f-prod').checked && !note.ko) toast('한국어 뜻이 없어서 산출 카드는 만들지 않았어요');
  if (dupCheck(en)) toast('비슷한 문장이 이미 있어요 — 그래도 추가했습니다');
  store.putNote(note); toast('추가됨 · 카드 ' + Object.keys(note.cards).length + '장');
  renderAdd(); $('#f-en').focus();
}
function dupCheck(text) { const s = stripCloze(text).toLowerCase().trim(); return store.liveNotes().some((n) => stripCloze(n.text || '').toLowerCase().trim() === s); }
function addMcd() {
  const { text, n } = buildClozeFromTokens(); if (!n) return;
  const note = makeNote({ text, ko: $('#m-ko').value, extra: $('#m-ex').value, src: $('#m-src').value }, settings);
  store.putNote(note); mcdTokens = null; mcdSel = new Set(); toast('MCD 카드 ' + n + '장 추가됨'); renderAdd();
}
function bulkImport(text) {
  let rows = parseDelimited(text); if ($('#b-head') && $('#b-head').checked) rows = rows.slice(1);
  const prod = $('#b-prod') ? $('#b-prod').checked : false; let added = 0, cards = 0, dup = 0;
  for (const r of rows) {
    const en = (r[0] || '').replace(/<[^>]+>/g, '').trim(); if (!en) continue;
    if (dupCheck(en)) { dup++; continue; }
    const note = makeNote({ text: en, ko: (r[1] || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''), extra: (r[2] || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''), src: r[3] || '', prod }, settings);
    note.c = Date.now() + added; store.putNote(note); added++; cards += Object.keys(note.cards).length;
  }
  toast(`${added}개 노트 · 카드 ${cards}장 추가${dup ? ` (중복 ${dup}개 건너뜀)` : ''}`);
  render();
}
function loadSamples() {
  let i = 0;
  for (const [en, ko, ex] of SAMPLE_SENTENCES) { const n = makeNote({ text: en, ko, extra: ex, src: '예제 덱', prod: i % 3 === 0 }, settings); n.c = Date.now() + i++; store.putNote(n); }
  for (const [en, ko, ex] of SAMPLE_CLOZES) { const n = makeNote({ text: en, ko, extra: ex, src: '예제 덱 (MCD)' }, settings); n.c = Date.now() + i++; store.putNote(n); }
  toast('예제 덱을 불러왔어요'); render();
}

// ----- browse -----
function cardStatus(c) {
  if (c.sus === 'leech') return '<span class="tag amber">리치·보류</span>';
  if (c.sus === 'retired') return '<span class="tag gray">은퇴</span>';
  if (c.sus === 'known') return '<span class="tag gray">앎·보류</span>';
  if (c.st === State.New && c.iv) return '<span class="tag red">소개됨</span>';
  if (c.sus) return '<span class="tag gray">보류</span>';
  if (c.bury && c.bury > Date.now()) return '<span class="tag gray">내일</span>';
  if (c.st === State.New) return '<span class="tag blue">새</span>';
  if (c.st !== State.Review) return '<span class="tag red">학습</span>';
  const d = c.due - Date.now(); return `<span class="tag green">${d <= 0 ? '오늘' : humanInterval(d)}</span>`;
}
function renderBrowse() {
  const q = browseQ.toLowerCase();
  let list = store.liveNotes().filter((n) => !q || (n.text + ' ' + (n.ko || '') + ' ' + (n.extra || '')).toLowerCase().includes(q));
  if (browseFilter === 'sent') list = list.filter((n) => n.type !== 'cloze');
  if (browseFilter === 'cloze') list = list.filter((n) => n.type === 'cloze');
  if (browseFilter === 'sus') list = list.filter((n) => Object.values(n.cards).some((c) => c.sus));
  if (browseFilter === 'leech') list = list.filter((n) => Object.values(n.cards).some((c) => c.l >= settings.leechLapses || c.sus === 'leech'));
  if (browseFilter === 'retired') list = list.filter((n) => Object.values(n.cards).some((c) => c.sus === 'retired'));
  list.sort((a, b) => b.c - a.c);
  const shown = list.slice(0, 300);
  const f = [['all', '전체'], ['sent', '문장'], ['cloze', 'MCD'], ['leech', '리치'], ['sus', '보류'], ['retired', '은퇴']].map(([k, l]) => `<button class="${browseFilter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('');
  app().innerHTML = `<h2 class="title">카드 목록 <small class="muted">${list.length}</small></h2>
  <input id="q" type="search" placeholder="검색 (영어·한국어·메모)" value="${esc(browseQ)}">
  <div class="seg small">${f}</div>
  <ul class="list">${shown.map((n) => `<li data-id="${n.id}"><div class="en1">${n.type === 'cloze' ? '<span class="tag">MCD</span> ' : ''}${esc(stripCloze(n.text)).slice(0, 160)}</div>${n.ko ? `<div class="ko1">${esc(n.ko).slice(0, 80)}</div>` : ''}<div class="tags">${Object.entries(n.cards).map(([k, c]) => `<span class="k">${k === 'rec' ? '이해' : k === 'prod' ? '산출' : k}</span>${cardStatus(c)}`).join(' ')}</div></li>`).join('') || '<li class="muted">카드가 없습니다</li>'}</ul>
  ${list.length > 300 ? '<p class="muted small center">검색으로 범위를 좁혀주세요 (300개까지 표시)</p>' : ''}`;
  const qi = $('#q'); qi.oninput = () => { browseQ = qi.value; clearTimeout(qi._t); qi._t = setTimeout(() => { renderBrowse(); const n = $('#q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
}
function editNote(id) {
  const n = store.notes.get(id); if (!n || n.del) return;
  const sus = Object.values(n.cards).every((c) => c.sus);
  modal(`<h3>카드 편집</h3>
    <label>영어 ${n.type === 'cloze' ? '(클로즈: {{c1::단어}})' : ''}<textarea id="e-en" rows="${n.type === 'cloze' ? 6 : 3}">${esc(n.text)}</textarea></label>
    <label>한국어<textarea id="e-ko" rows="2">${esc(n.ko || '')}</textarea></label>
    <label>메모/Extra<textarea id="e-ex" rows="2">${esc(n.extra || '')}</textarea></label>
    <label>출처<input id="e-src" value="${esc(n.src || '')}"></label>
    ${n.type !== 'cloze' ? `<label class="chk"><input type="checkbox" id="e-prod" ${n.cards.prod ? 'checked' : ''}> 한→영 산출 카드</label>` : ''}
    <div class="row wrap"><button class="btn ghost" data-e="say">🔊 듣기</button><button class="btn ghost" data-e="sus">${sus ? '보류 해제' : '보류'}</button><button class="btn ghost" data-e="reset">진도 초기화</button><button class="btn danger" data-e="del">삭제</button></div>
    <div class="row end"><button class="btn ghost" data-e="close">닫기</button><button class="btn primary" data-e="save">저장</button></div>`, (el) => {
    el.onclick = (e) => {
      const b = e.target.closest('[data-e]'); if (!b) return; const a = b.dataset.e;
      if (a === 'close') closeModal();
      if (a === 'say') speak($('#e-en').value);
      if (a === 'save') {
        const text = $('#e-en').value.trim(); if (!text) return toast('영어 칸이 비었습니다');
        n.text = text; n.ko = $('#e-ko').value.trim(); n.extra = $('#e-ex').value.trim(); n.src = $('#e-src').value.trim();
        syncCards(n, settings, $('#e-prod') ? $('#e-prod').checked : undefined); store.putNote(n); closeModal(); toast('저장됨');
        if (view === 'review') { sess.item = null; } render();
      }
      if (a === 'sus') { for (const c of Object.values(n.cards)) c.sus = !sus; store.putNote(n); closeModal(); if (view === 'review') sess.item = null; render(); }
      if (a === 'reset') confirmBox('이 노트의 복습 기록을 지우고 새 카드로 되돌릴까요?', '초기화', () => { for (const k of Object.keys(n.cards)) n.cards[k] = newCardState(); store.putNote(n); if (view === 'review') sess.item = null; render(); });
      if (a === 'del') confirmBox('이 노트와 카드 ' + Object.keys(n.cards).length + '장을 삭제할까요?', '삭제', () => { store.deleteNote(id); if (view === 'review') sess.item = null; toast('삭제됨'); render(); }, true);
    };
  });
}

// ----- settings -----
function renderSettings() {
  const vopts = voices.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === settings.ttsVoice ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  app().innerHTML = `<h2 class="title">설정</h2>
  <section class="card form">
    <h3>복습</h3>
    <label>하루 새 카드 수<input type="number" min="0" max="500" data-set="newPerDay" value="${settings.newPerDay}"></label>
    <p class="tip ${settings.newPerDay > 30 ? 'warn' : ''}">30장 이하 권장 (ajatt.top). 새 카드 1장은 앞으로 약 10번의 복습을 부릅니다.</p>
    <label>하루 최대 복습 수<input type="number" min="10" max="9999" data-set="maxReviews" value="${settings.maxReviews}"></label>
    <label>목표 기억률 (FSRS) <b id="retv">${Math.round(settings.retention * 100)}%</b><input type="range" min="0.8" max="0.97" step="0.01" data-set="retention" value="${settings.retention}"></label>
    <p class="tip">높일수록 더 자주 복습합니다. Anki 기본값은 90%.</p>
    <label>새 카드 섞기: 복습 N장마다 1장<input type="number" min="1" max="50" data-set="newMix" value="${settings.newMix}"></label>
    <label>리치 기준 (잊은 횟수 → 자동 보류)<input type="number" min="2" max="30" data-set="leechLapses" value="${settings.leechLapses}"></label>
    <label>하루 시작 시각<input type="number" min="0" max="12" data-set="dayStartHour" value="${settings.dayStartHour}"></label>
    <label class="chk"><input type="checkbox" data-set="showChecklist" ${settings.showChecklist ? 'checked' : ''}> 채점 기준 안내 표시</label>
  </section>
  <section class="card form">
    <h3>복습 방식 (ajatt.top)</h3>
    <label class="chk"><input type="checkbox" data-set="passFail" ${settings.passFail ? 'checked' : ''}> 두 버튼 모드 (다시 / 알맞음만)</label>
    <label class="chk"><input type="checkbox" data-set="frontGrade" ${settings.frontGrade ? 'checked' : ''}> 앞면에서 바로 채점</label>
    <label>학습 중 카드 상한 (넘으면 새 카드 멈춤)<input type="number" min="5" max="200" data-set="learnCap" value="${settings.learnCap}"></label>
    <label>같은 날 N번 틀리면 내일로 미루기 (0 = 끔)<input type="number" min="0" max="20" data-set="dayFailBury" value="${settings.dayFailBury}"></label>
    <label>은퇴 기준: 다음 간격 N년 이상 (0 = 끔)<input type="number" min="0" max="50" data-set="retireYears" value="${settings.retireYears}"></label>
    <label>복습 순서<select data-set="backlogOrder">
      <option value="auto" ${settings.backlogOrder === 'auto' ? 'selected' : ''}>자동 (밀렸을 때만 기억 가능성 높은 순)</option>
      <option value="retrievability" ${settings.backlogOrder === 'retrievability' ? 'selected' : ''}>항상 기억 가능성 높은 순</option>
      <option value="due" ${settings.backlogOrder === 'due' ? 'selected' : ''}>항상 예정일 순 (Anki 기본)</option></select></label>
    <label class="chk"><input type="checkbox" data-set="introNew" ${settings.introNew ? 'checked' : ''}> 새 카드는 답과 함께 먼저 소개 (노출 → 1분·10분 → 1일)</label>
    <label class="chk"><input type="checkbox" data-set="speedGrade" ${settings.speedGrade ? 'checked' : ''}> 속도 채점: 느리게 떠올린 '알맞음'은 '어려움'으로 기록</label>
    <label>느림 기준 (초) — 문장 기준, MCD는 +4초<input type="number" min="3" max="60" data-set="speedSec" value="${settings.speedSec}"></label>
    <p class="tip">속도 채점은 두 버튼 모드에서 복습 단계 카드에만 적용됩니다. 한→영 산출 카드는 타이핑 때문에 제외. 앱을 내려둔 시간은 빼고 잽니다.</p>
    <label class="chk"><input type="checkbox" data-set="recorder" ${settings.recorder ? 'checked' : ''}> 답 화면에 녹음·비교 버튼 (홈 화면 앱에서만)</label>
    <p class="tip">실제 기억률(30일): <b>${(() => { const tr = trueRetention(store.meta.days, settings); return tr.rate == null ? '–' : Math.round(tr.rate * 100) + '% (' + tr.count + '회)'; })()}</b> · 목표 75~90%. 낮으면 위 목표 기억률을 올리고, 높으면 내리세요.</p>
    <label class="chk"><input type="checkbox" data-set="prodDefault" ${settings.prodDefault ? 'checked' : ''}> 새 문장에 한→영 산출 카드 기본 생성</label>
  </section>
  <section class="card form">
    <h3>발음 (TTS)</h3>
    ${(() => {
      if (!voices.length) return '<p class="tip">이 화면에서는 기기 영어 음성을 찾지 못했어요. 홈 화면 앱이나 Safari에서 열어 보세요.</p>';
      const cur = pickVoice(); const best = Math.max(...voices.map(voiceTier));
      const opts = voices.filter((v) => voiceTier(v) >= 0).map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === settings.ttsVoice ? 'selected' : ''}>${voiceTier(v) >= 3 ? '★ ' : ''}${esc(v.name)} · ${ACCENTS[(v.lang || '').replace('_', '-')] || esc(v.lang)}${TIER_LABEL[voiceTier(v)] ? ' · ' + TIER_LABEL[voiceTier(v)] : ''}</option>`).join('');
      const hidden = voices.filter((v) => voiceTier(v) < 0).length;
      return `<label>억양<select data-set="ttsAccent">${['en-US', 'en-GB', 'en-AU'].map((a) => `<option value="${a}" ${(settings.ttsAccent || 'en-US') === a ? 'selected' : ''}>${ACCENTS[a]}</option>`).join('')}</select></label>
      <label>목소리<select data-set="ttsVoice"><option value="">자동 — 가장 자연스러운 음성 (지금: ${esc(cur ? cur.name : '없음')})</option>${opts}</select></label>
      ${hidden ? `<p class="tip">장난감·로봇 음성 ${hidden}개(Albert, Bubbles, Zarvox, Grandpa 등)는 목록에서 뺐어요.</p>` : ''}
      ${best < 3 ? `<div class="note warn"><b>더 자연스러운 음성 받기 (아이폰, 무료)</b><br>설정 → 손쉬운 사용 → 읽기 및 말하기 → 음성 → 영어 → <b>Ava, Zoe, Evan</b> 중 하나를 골라 <b>'고품질(Premium)'</b> 또는 <b>'향상된 품질(Enhanced)'</b>을 내려받으세요. 다운로드 후 이 앱을 완전히 닫았다가 다시 열면 ★ 표시와 함께 자동으로 선택됩니다. (Siri 음성은 웹 앱에서 쓸 수 없어요.)</div>` : `<p class="tip">★ 고음질 음성 ${voices.filter((v) => voiceTier(v) >= 3).length}개를 찾았어요.</p>`}`;
    })()}
    <label>속도 <b id="ratev">${settings.ttsRate}</b><input type="range" min="0.5" max="1.3" step="0.05" data-set="ttsRate" value="${settings.ttsRate}"></label>
    <label class="chk"><input type="checkbox" data-set="autoPlay" ${settings.autoPlay ? 'checked' : ''}> 카드 표시 시 자동 재생</label>
    <button class="btn" data-act="tts-test">🔊 테스트</button>
  </section>
  <section class="card form" id="backup">
    <h3>내보내기</h3>
    <p class="muted small">${cloudBadge()} · 마지막 백업: ${store.meta.lastBackup ? new Date(store.meta.lastBackup).toLocaleString('ko-KR') : '없음'}</p>
    <div class="row wrap"><button class="btn primary" data-act="exp-json">전체 백업 파일 (.json)</button><button class="btn" data-act="exp-tsv">Anki용 텍스트 (.txt)</button><button class="btn ghost" data-act="copy-json">백업 내용 복사</button></div>
    <p class="tip">아이폰에서는 공유 시트가 열립니다 → <b>"파일에 저장"</b>(iCloud Drive), AirDrop, 카카오톡 '나에게' 등으로 보관하세요. 전체 백업에는 복습 기록과 설정이 모두 들어갑니다.</p>
  </section>
  <section class="card form">
    <h3>가져오기</h3>
    <label>백업 파일 복원 (.json)<input type="file" id="imp-file"></label>
    <label>또는 백업 내용 붙여넣기<textarea id="imp-text" rows="3" placeholder='{"app":"ankiwords", ...}'></textarea></label>
    <button class="btn" data-act="imp-paste">붙여넣은 내용 복원</button>
    <p class="tip">복원은 현재 카드와 <b>합치기</b> 방식입니다. 같은 카드는 더 최근에 수정된 쪽이 남습니다. 문장 목록(CSV·TSV·TXT, Anki 내보내기 텍스트)은 <button class="link" data-go-add-bulk>추가 → 일괄 가져오기</button>를 쓰세요.</p>
  </section>
  <section class="card form" id="app-section"><h3>앱</h3>
    <p class="small">현재 버전 <b>${verLabel(APP_VERSION)}</b>${window.claude ? '' : hasUpdate() ? ` · <span class="green">새 버전 ${verLabel(upd.latest)} 있음</span>` : upd.checked && upd.latest ? ' · 최신 버전이에요' : ''}</p>
    <button class="btn ${hasUpdate() ? 'primary' : ''}" data-act="app-refresh">🔄 앱 새로고침</button>
    <p class="tip">화면이 이상하거나 새 기능이 안 보일 때 누르세요. 저장 안 된 복습을 먼저 저장하고, 앱 파일만 새로 받아요. 카드와 복습 기록은 지워지지 않아요.</p>
  </section>
  <section class="card form"><h3>위험 구역</h3><button class="btn danger" data-act="wipe">모든 카드 삭제</button></section>
  <p class="muted small center">스케줄러: FSRS (ts-fsrs) · Anki 23.10+와 같은 알고리즘 계열</p>`;
}
async function saveFile(name, data, mime) {
  // 1) Claude artifact page: platform download
  if (window.claude && window.claude.use) {
    try { const dl = await window.claude.use('downloads'); if (dl) { await dl.save({ filename: name, data }); return true; } }
    catch (e) { if (e && e.code) { toast('저장이 취소되었어요'); return false; } }
  }
  // 2) phone share sheet (iOS 15+/Android): 파일에 저장, AirDrop, 메신저 …
  try {
    const file = new File([data], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
  } catch (e) { if (e && e.name === 'AbortError') { toast('공유를 취소했어요'); return false; } }
  // 3) classic download
  try {
    const blob = new Blob([data], { type: mime }); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000); return true;
  } catch (e) {}
  // 4) last resort: show the text to copy
  modal(`<h3>${esc(name)}</h3><p class="muted small">파일 저장이 막혀 있어요. 아래 내용을 복사해 보관하세요.</p><textarea rows="8" readonly>${esc(data)}</textarea><div class="row end"><button class="btn" data-x>닫기</button></div>`, (el) => { el.querySelector('[data-x]').onclick = closeModal; });
  return false;
}
async function exportBackup() {
  const ok = await saveFile('english-anki-backup-' + dayKey(settings) + '.json', store.exportJSON(), 'application/json');
  if (ok) { store.putMeta((m) => { m.lastBackup = Date.now(); }); if (view === 'settings') render(true); }
}
function doImport(txt) {
  let d; try { d = JSON.parse(txt); } catch (e) { return toast('백업 형식(JSON)이 아니에요. 문장 목록은 "일괄 가져오기"를 쓰세요'); }
  if (!d || !Array.isArray(d.notes)) return toast('이 앱의 백업 파일이 아니에요');
  const nCards = d.notes.reduce((a, n) => a + Object.keys(n.cards || {}).length, 0);
  confirmBox(`백업 (${(d.exported || '').slice(0, 10)}) · 노트 ${d.notes.length}개 · 카드 ${nCards}장을 현재 데이터와 합칠까요?`, '복원', () => {
    try { const n = store.importJSON(txt); loadSettings(); toast(n + '개 노트를 복원했어요'); render(); } catch (err) { toast('복원 실패: ' + err.message); }
  });
}
function exportTSV() {
  const clean = (s) => (s || '').replace(/\t/g, ' ').replace(/\n/g, '<br>');
  const lines = ['#separator:tab', '#html:true', '#columns:Text\tBack\tExtra\tSource'];
  for (const n of store.liveNotes()) lines.push([n.text, n.ko, n.extra, n.src].map(clean).join('\t'));
  saveFile('english-sentences-anki.txt', lines.join('\n'), 'text/plain');
}

// ---------------- events ----------------
document.addEventListener('click', (e) => {
  const t = e.target;
  const nav = t.closest('[data-go]'); if (nav) return go(nav.dataset.go);
  if (t.closest('[data-go-add-bulk]')) { addMode = 'bulk'; return go('add'); }
  const navb = t.closest('nav button'); if (navb) return go(navb.dataset.v);
  const say = t.closest('[data-say]'); if (say) { e.stopPropagation(); return speak(say.dataset.say); }
  const g = t.closest('[data-grade]'); if (g) return grade(+g.dataset.grade);
  const mode = t.closest('[data-mode]'); if (mode) { addMode = mode.dataset.mode; return renderAdd(); }
  const sm = t.closest('[data-sm]'); if (sm) { statsMode = sm.dataset.sm; return render(true); }
  const sr = t.closest('[data-sr]'); if (sr) { statsRange = +sr.dataset.sr; return render(true); }
  const sn = t.closest('[data-sn]'); if (sn) { simNew = +sn.dataset.sn; return render(true); }
  const flt = t.closest('[data-filter]'); if (flt) { browseFilter = flt.dataset.filter; return renderBrowse(); }
  const li = t.closest('.list li[data-id]'); if (li) return editNote(li.dataset.id);
  const tok = t.closest('[data-tok]'); if (tok) { const i = +tok.dataset.tok; mcdSel.has(i) ? mcdSel.delete(i) : mcdSel.add(i); const y = window.scrollY; const ko = $('#m-ko')?.value, ex = $('#m-ex')?.value, src = $('#m-src')?.value; renderAdd(); if (ko != null) { $('#m-ko').value = ko; $('#m-ex').value = ex; $('#m-src').value = src; } window.scrollTo(0, y); return; }
  const act = t.closest('[data-act]'); if (!act) return;
  const a = act.dataset.act;
  if (a === 'show') showAnswer();
  else if (a === 'hint') { const ta = $('#typed'); if (ta) sess.typed = ta.value; sess.hint = 1; render(); }
  else if (a === 'undo') undo();
  else if (a === 'edit') editNote(act.dataset.id);
  else if (a === 'sample') loadSamples();
  else if (a === 'add-sent') addSentence();
  else if (a === 'mcd-next') {
    const txt = $('#m-text').value.trim(); if (!txt) return toast('문단을 붙여넣으세요');
    if (isCloze(txt)) { const n = makeNote({ text: txt }, settings); store.putNote(n); toast('MCD 카드 ' + Object.keys(n.cards).length + '장 추가됨'); return renderAdd(); }
    mcdTokens = tokenize(txt); mcdSel = new Set(); renderAdd();
  }
  else if (a === 'mcd-back') { const txt = mcdTokens.join(''); mcdTokens = null; renderAdd(); $('#m-text').value = txt; }
  else if (a === 'add-mcd') addMcd();
  else if (a === 'bulk') { const txt = $('#b-text').value; if (txt.trim()) bulkImport(txt); else toast('파일을 고르거나 내용을 붙여넣으세요'); }
  else if (a === 'intro-ok') introduce(false);
  else if (a === 'intro-known') introduce(true);
  else if (a === 'rec') recToggle();
  else if (a === 'rec-play') recPlay();
  else if (a === 'tts-test') speak("I've been meaning to ask you something. Could we push the meeting back to Thursday?");
  else if (a === 'exp-json') exportBackup();
  else if (a === 'app-refresh') appRefresh();
  else if (a === 'imp-paste') { const v = $('#imp-text').value.trim(); if (!v) return toast('백업 내용을 붙여넣으세요'); doImport(v); }
  else if (a === 'copy-json') navigator.clipboard.writeText(store.exportJSON()).then(() => toast('백업 내용을 복사했어요. 메모 앱 등에 붙여넣어 보관하세요'), () => toast('복사가 막혀 있어요'));
  else if (a === 'exp-tsv') exportTSV();
  else if (a === 'wipe') confirmBox('모든 카드와 복습 기록을 삭제합니다. 되돌릴 수 없어요. 백업은 하셨나요?', '모두 삭제', () => { for (const n of store.liveNotes()) store.deleteNote(n.id); store.putMeta((m) => { m.days = {}; }); toast('삭제됨'); render(); }, true);
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.set) {
    const k = t.dataset.set; let v = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.type === 'range' ? +t.value : t.value;
    if (t.type === 'number') { const mn = +t.min, mx = +t.max; if (!Number.isFinite(v)) v = DEFAULT_SETTINGS[k]; v = Math.min(mx, Math.max(mn, Math.round(v))); t.value = v; }
    saveSettings({ [k]: v });
    if (k === 'ttsAccent' || k === 'ttsVoice') { loadVoices(); render(true); if (k === 'ttsVoice') speak('This is how I sound.'); }
  }
  if (t.id === 'b-file' && t.files[0]) t.files[0].text().then((txt) => { $('#b-text').value = txt; toast(parseDelimited(txt).length + '줄을 읽었어요. "가져오기"를 누르세요'); });
  if (t.id === 'imp-file' && t.files[0]) { const f = t.files[0]; t.value = ''; f.text().then(doImport); }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.set === 'retention') $('#retv').textContent = Math.round(+t.value * 100) + '%';
  if (t.dataset.set === 'ttsRate') $('#ratev').textContent = t.value;
});
document.addEventListener('keydown', (e) => {
  if (view !== 'review' || !sess.item || /TEXTAREA|INPUT/.test(e.target.tagName) || $('#modal').classList.contains('show')) return;
  // ajatt.top / AJT Flexible Grading keys: h j k l = Again Hard Good Easy (or 1–4)
  const km = { h: 1, j: 2, k: 3, l: 4, 1: 1, 2: 2, 3: 3, 4: 4 }[e.key];
  if (isIntro(sess.item)) { if (e.key === ' ' || e.key === 'Enter' || e.key === 'k') { e.preventDefault(); introduce(false); } else if (e.key === 'r') speak(sess.speakText); return; }
  if (sess.side === 'front' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); showAnswer(); }
  else if (km && (sess.side === 'back' || (settings.frontGrade && (km === 1 || km === 3)))) grade(km);
  else if (e.key === 'V' && sess.side === 'back' && recSupported()) recToggle();
  else if (e.key === 'v') recPlay();
  else if (sess.side === 'back' && e.key === ' ') { e.preventDefault(); grade(Rating.Good); }
  else if (e.key === 'r') speak(sess.speakText);
});

// ---------------- boot ----------------
(async function boot() {
  await store.init(); loadSettings(); render();
  store.onChange((kind) => {
    if (kind === 'data') {
      loadSettings();
      if ($('#modal').classList.contains('show')) return;
      if (view === 'home' || view === 'browse') render(true);
      else if (view === 'review' && sess.side === 'front' && !($('#typed') && $('#typed').value)) { sess.item = null; render(true); }
    }
    if (kind === 'cloud' && view === 'home') render(true);
  });
  store.connectCloud();
  if (window.claude && window.claude.use && !('speechSynthesis' in window)) window.claude.use('tts').then((t) => { claudeTTS = t; }).catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !/claude|anthropic/.test(location.hostname)) navigator.serviceWorker.register('sw.js').catch(() => {});
  // after an app refresh, tidy the URL (?r=…) and say which version is running
  if (/[?&]r=/.test(location.search)) { const u = new URL(location.href); u.searchParams.delete('r'); history.replaceState(null, '', u.toString()); setTimeout(() => toast('앱을 새로 불러왔어요 · ' + verLabel(APP_VERSION)), 300); }
  const recheck = () => checkUpdate().then(() => { if (hasUpdate() && (view === 'home' || view === 'settings')) render(true); });
  recheck();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });   // came back to the app
  setInterval(() => { if (view === 'home' && !$('#modal').classList.contains('show')) render(true); }, 60e3);
})();
void uid;
