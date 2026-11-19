// Card model + FSRS scheduling (ts-fsrs, the same algorithm family Anki uses since 23.10).
import { fsrs, createEmptyCard, generatorParameters, Rating, State } from 'ts-fsrs';
export { Rating, State };

export const DEFAULT_SETTINGS = {
  newPerDay: 20,
  maxReviews: 300,
  retention: 0.9,
  dayStartHour: 4,
  ttsRate: 1,
  ttsVoice: '',
  ttsAccent: 'en-US',
  autoPlay: true,
  prodDefault: false,     // also make KO→EN production card for sentence notes
  newMix: 4,              // show 1 new card after every N reviews
  leechLapses: 5,         // ajatt.top: 4–6, then auto-suspend
  showChecklist: true,
  passFail: true,         // ajatt.top: only Again / Good
  frontGrade: true,       // grade confidently from the front side
  learnCap: 30,           // stop new cards while ≥30 cards are in learning
  dayFailBury: 3,         // fail the same card N times today → bury till tomorrow (Mortician)
  retireYears: 10,        // interval ≥ N years → retire (suspend); 0 = off
  backlogOrder: 'auto',   // auto | due | retrievability
  recorder: true,         // record & compare pronunciation (home-screen app only)
  speedGrade: true,       // slow recall + Good → recorded as Hard (two-button mode, review cards)
  speedSec: 8,            // "slow" threshold in seconds for sentence cards (MCD +4s)
  introNew: true,         // show a new card with its answer first (exposure), then start learning steps
};

let _sched = null, _schedKey = '';
export function scheduler(settings) {
  const key = String(settings.retention);
  if (_sched && key === _schedKey) return _sched;
  _sched = fsrs(generatorParameters({ request_retention: settings.retention, maximum_interval: 36500, enable_fuzz: true, enable_short_term: true }));
  _schedKey = key; return _sched;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- (de)serialise FSRS card ----
export function newCardState(now = new Date()) { return packCard(createEmptyCard(now)); }
export function packCard(c) {
  return { due: +new Date(c.due), s: c.stability, d: c.difficulty, ed: c.elapsed_days, sd: c.scheduled_days, r: c.reps, l: c.lapses, ls: c.learning_steps || 0, st: c.state, lr: c.last_review ? +new Date(c.last_review) : null };
}
export function unpackCard(p) {
  return { due: new Date(p.due), stability: p.s, difficulty: p.d, elapsed_days: p.ed, scheduled_days: p.sd, reps: p.r, lapses: p.l, learning_steps: p.ls || 0, state: p.st, last_review: p.lr ? new Date(p.lr) : undefined };
}

// ---- Cloze parsing:  {{c1::answer}}  or {{c1::answer::hint}} ----
const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
export function clozeNumbers(text) {
  const s = new Set(); let m; CLOZE_RE.lastIndex = 0;
  while ((m = CLOZE_RE.exec(text))) s.add(+m[1]);
  return [...s].sort((a, b) => a - b);
}
export function stripCloze(text) { return text.replace(CLOZE_RE, (_, n, a) => a); }
export function isCloze(text) { CLOZE_RE.lastIndex = 0; return CLOZE_RE.test(text); }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { esc };

// split into sentences while keeping cloze markers intact
export function splitSentences(text) {
  const out = []; let buf = ''; let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (text.startsWith('{{', i)) depth++;
    if (text.startsWith('}}', i) && depth > 0) depth--;
    buf += ch;
    if (depth === 0 && /[.!?]/.test(ch)) {
      // include closing quotes/brackets
      while (i + 1 < text.length && /["'”’)\]]/.test(text[i + 1])) { buf += text[++i]; }
      if (i + 1 >= text.length || /\s/.test(text[i + 1])) { out.push(buf); buf = ''; }
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// Render cloze card. side: 'front' | 'back'. Returns {html, targetSentence}
export function renderCloze(text, n, side) {
  const sentences = splitSentences(text);
  let targetSentence = '';
  const html = sentences.map((s) => {
    const hasTarget = new RegExp('\\{\\{c' + n + '::').test(s);
    if (hasTarget) targetSentence = stripCloze(s).trim();
    const inner = esc(s).replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_, k, a, h) => {
      if (+k !== n) return a;
      if (side === 'front') return '<span class="cz">[' + (h ? h : '…') + ']</span>';
      return '<span class="cz on">' + a + '</span>';
    });
    return hasTarget ? '<span class="focus">' + inner + '</span>' : '<span class="ctx">' + inner + '</span>';
  }).join('');
  return { html, targetSentence };
}

export function clozeAnswer(text, n) {
  const re = new RegExp('\\{\\{c' + n + '::([\\s\\S]*?)(?:::[\\s\\S]*?)?\\}\\}', 'g');
  const a = []; let m; while ((m = re.exec(text))) a.push(m[1]); return a.join(' … ');
}

// ---- Note factory ----
export function makeNote({ text, ko = '', extra = '', src = '', tags = [], prod }, settings) {
  const now = new Date();
  const note = { id: uid(), text: text.trim(), ko: ko.trim(), extra: extra.trim(), src: src.trim(), tags, c: Date.now(), cards: {} };
  syncCards(note, settings, prod, now);
  return note;
}
// make sure note.cards matches its content (cloze numbers / rec / prod)
export function syncCards(note, settings, prod, now = new Date()) {
  const want = new Set();
  if (isCloze(note.text)) { for (const n of clozeNumbers(note.text)) want.add('c' + n); note.type = 'cloze'; }
  else {
    note.type = 'sent'; want.add('rec');
    const p = prod === undefined ? !!note.cards.prod : prod;
    if (p && note.ko) want.add('prod');
  }
  for (const k of want) if (!note.cards[k]) note.cards[k] = newCardState(now);
  for (const k of Object.keys(note.cards)) if (!want.has(k)) delete note.cards[k];
}

// ---- Day helpers (day starts at settings.dayStartHour, like Anki's 4am rollover) ----
export function dayKey(settings, t = Date.now()) {
  const d = new Date(t - settings.dayStartHour * 3600e3);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function endOfDay(settings, t = Date.now()) {
  const d = new Date(t - settings.dayStartHour * 3600e3);
  d.setHours(24, 0, 0, 0);
  return +d + settings.dayStartHour * 3600e3;
}

// ---- Queue ----
// returns {learn, review, fresh, laterLearn} arrays of {note, key, card}
export function buildQueues(notes, settings, todayStats, now = Date.now()) {
  const eod = endOfDay(settings, now);
  const learn = [], review = [], fresh = [], laterLearn = [];
  for (const note of notes) {
    if (note.del) continue;
    for (const [key, c] of Object.entries(note.cards || {})) {
      if (c.sus) continue;
      if (c.bury && c.bury >= now) continue;
      const item = { note, key, card: c };
      if (c.st === State.New) {
        if (c.iv) { if (c.due <= now) learn.push(item); else if (c.due < eod) laterLearn.push(item); continue; } // introduced, waiting for its first test
        if (key === 'prod' && note.cards.rec && note.cards.rec.st === State.New) continue;
        fresh.push(item);
      }
      else if (c.st === State.Learning || c.st === State.Relearning) {
        if (c.due <= now) learn.push(item); else if (c.due < eod) laterLearn.push(item);
      } else if (c.due < eod) review.push(item);
    }
  }
  learn.sort((a, b) => a.card.due - b.card.due);
  laterLearn.sort((a, b) => a.card.due - b.card.due);
  // backlog: Anki shows the oldest overdue first, which keeps you forgetting.
  // ajatt.top: recover the cards you are most likely to still remember first.
  const sod = eod - 86400e3;
  const overdue = review.filter((x) => x.card.due < sod).length;
  const revCap = Math.max(0, settings.maxReviews - (todayStats.rv || 0));
  const backlog = overdue > 0 && review.length > revCap;
  const order = settings.backlogOrder === 'auto' ? (backlog ? 'retrievability' : 'due') : settings.backlogOrder;
  if (order === 'retrievability') {
    const f = scheduler(settings); const at = new Date(now);
    for (const x of review) x.R = f.get_retrievability(unpackCard(x.card), at, false);
    review.sort((a, b) => b.R - a.R || a.card.due - b.card.due);
  } else review.sort((a, b) => a.card.due - b.card.due);
  // new: by creation order, cloze siblings in number order
  const rank = (k) => k === 'rec' ? 0 : k === 'prod' ? 1e6 : +k.slice(1) || 0;
  fresh.sort((a, b) => (a.note.c - b.note.c) || (rank(a.key) - rank(b.key)));
  const learnTotal = learn.length + laterLearn.length;
  const learnFlood = learnTotal >= settings.learnCap;
  const newLeft = learnFlood ? 0 : Math.max(0, settings.newPerDay - (todayStats.n || 0));
  const revLeft = Math.max(0, settings.maxReviews - (todayStats.rv || 0));
  // one new sibling per note per session (spread MCD clozes across days like Anki's sibling burying)
  const seen = new Set(); const freshPicked = [];
  for (const it of fresh) { if (freshPicked.length >= newLeft) break; if (seen.has(it.note.id)) continue; seen.add(it.note.id); freshPicked.push(it); }
  if (freshPicked.length < newLeft) for (const it of fresh) { if (freshPicked.length >= newLeft) break; if (!freshPicked.includes(it)) freshPicked.push(it); }
  return { learn, review: review.slice(0, revLeft), fresh: freshPicked, laterLearn, freshTotal: fresh.length, overdue, backlog, reviewTotal: review.length, learnFlood, order };
}

export function pickNext(q, settings, sessionCount, lastNoteId) {
  const avoid = (arr) => arr.find((x) => x.note.id !== lastNoteId) || arr[0];
  if (q.learn.length) return avoid(q.learn);
  const mixNew = q.fresh.length && (!q.review.length || (sessionCount % (settings.newMix + 1) === settings.newMix));
  if (mixNew) return avoid(q.fresh);
  if (q.review.length) return avoid(q.review);
  // learn-ahead (Anki default 20 min)
  const ahead = q.laterLearn.filter((x) => x.card.due - Date.now() < 20 * 60e3);
  if (ahead.length) return ahead[0];
  return null;
}

export function previewIntervals(cardPacked, settings, now = new Date()) {
  const f = scheduler(settings);
  const r = f.repeat(unpackCard(cardPacked), now);
  const out = {};
  for (const g of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) out[g] = +r[g].card.due - +now;
  return out;
}
export function answer(cardPacked, rating, settings, now = new Date()) {
  const f = scheduler(settings);
  const res = f.next(unpackCard(cardPacked), now, rating);
  const p = packCard(res.card);
  for (const k of ['sus', 'fd', 'fc', 'iv']) if (cardPacked[k] !== undefined) p[k] = cardPacked[k];
  return p;
}
// leech fires at the threshold, then every half-threshold after (like Anki)
// speed grading threshold (ms) for a card; null = not applicable
export function slowThresholdMs(key, settings) {
  if (key === 'prod') return null;               // typing answers are slow by nature
  return (settings.speedSec + (key.startsWith('c') ? 4 : 0)) * 1000;
}
export function isLeechHit(lapses, threshold) {
  if (lapses < threshold) return false;
  return (lapses - threshold) % Math.max(1, Math.ceil(threshold / 2)) === 0;
}
// true retention over the last N days (review-state cards only, like Anki's True Retention)
export function trueRetention(days, settings, n = 30, now = Date.now()) {
  let tr = 0, fail = 0;
  for (let i = 0; i < n; i++) { const d = days[dayKey(settings, now - i * 86400e3)]; if (d && d.tr) { tr += d.tr; fail += d.trf || 0; } }
  return { count: tr, rate: tr ? 1 - fail / tr : null };
}

// ---- Review history stats (Anki "Reviews" graph) ----
// days[k] may carry optional fields added later: ms (answer time sum), tc (answers timed), mt (mature reviews).
export const MATURE_DAYS = 21;       // Anki: interval ≥ 21 days = mature
export const ANSWER_CAP_MS = 60e3;   // Anki caps one answer at 60 s so a walk-away doesn't skew time
// split one day's reviews into Anki's colours: new(learn) / again(relearn) / young / mature
export function daySplit(d) {
  if (!d) return { n: 0, ag: 0, young: 0, mt: 0, rv: 0, ms: 0, tc: 0 };
  const rv = d.rv || 0, n = Math.min(rv, d.n || 0), ag = Math.min(rv - n, d.ag || 0), mt = Math.min(rv - n - ag, d.mt || 0);
  return { n, ag, mt, young: rv - n - ag - mt, rv, ms: d.ms || 0, tc: d.tc || 0 };
}
function addDays(key, i) { const [y, m, d] = key.split('-').map(Number); const t = new Date(y, m - 1, d + i); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); }
// range: number of days back (30/90/365), or 0 = since the first recorded day
export function reviewHistory(days, settings, range = 30, now = Date.now()) {
  const today = dayKey(settings, now);
  const keys = Object.keys(days || {}).filter((k) => (days[k].rv || 0) > 0 && k <= today).sort();
  const first = keys[0] || today;
  const span = Math.round((Date.parse(today) - Date.parse(first)) / 86400e3) + 1;      // days since first study
  const len = range ? range : Math.max(1, span);
  const bsize = len <= 31 ? 1 : len <= 365 ? 7 : Math.ceil(len / 60);
  const nb = Math.ceil(len / bsize);
  const buckets = []; let cum = 0, cumMs = 0;
  const tot = { rv: 0, ms: 0, tc: 0, studied: 0, msDays: 0 };
  for (let b = 0; b < nb; b++) {
    const x = { start: null, n: 0, ag: 0, young: 0, mt: 0, rv: 0, ms: 0 };
    // buckets end at today; bucket b (oldest first) holds the days that are o days ago, o in [base, base+bsize)
    const base = (nb - 1 - b) * bsize;
    for (let j = bsize - 1; j >= 0; j--) {
      const off = base + j;
      if (off >= len) continue;
      const k = addDays(today, -off); if (!x.start || k < x.start) x.start = k;
      const s = daySplit(days[k]);
      x.n += s.n; x.ag += s.ag; x.young += s.young; x.mt += s.mt; x.rv += s.rv; x.ms += s.ms;
      tot.rv += s.rv; tot.ms += s.ms; tot.tc += s.tc; if (s.rv) tot.studied++; if (s.tc) tot.msDays++;
    }
    cum += x.rv; cumMs += x.ms; x.cum = cum; x.cumMs = cumMs; buckets.push(x);
  }
  // "period" like Anki: the shown range, but never before the first day you studied
  const period = Math.max(1, Math.min(len, span));
  return {
    buckets, bucketDays: bsize, len, period, studied: tot.studied, total: tot.rv, totalMs: tot.ms, timed: tot.tc, timedDays: tot.msDays,
    avgStudied: tot.studied ? tot.rv / tot.studied : 0, avgPeriod: tot.rv / period,
    msStudied: tot.msDays ? tot.ms / tot.msDays : 0, msPeriod: tot.ms / period,
    avgAnswerMs: tot.tc ? tot.ms / tot.tc : null,
  };
}
// share of days studied in the last n days (Anki "Days studied"), counted from the first study day at most
export function studyRate(days, settings, n = 30, now = Date.now()) {
  const h = reviewHistory(days, settings, n, now);
  return { studied: h.studied, period: h.period, rate: h.studied / h.period };
}
// minutes needed for `cards` answers at your recent pace (falls back to fallbackMs until ≥ 20 timed answers)
export function estimateMs(cards, days, settings, fallbackMs = 10e3, now = Date.now()) {
  const h = reviewHistory(days, settings, 30, now);
  const per = h.timed >= 20 ? h.avgAnswerMs : fallbackMs;
  return { ms: cards * per, measured: h.timed >= 20, per };
}
export function fmtDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return Math.round(s) + '초';
  const m = s / 60; if (m < 60) return Math.round(m) + '분';
  const h = m / 60; if (h < 24) return (Math.round(h * 10) / 10) + '시간';
  return (Math.round(h / 24 * 10) / 10) + '일';
}

export function humanInterval(ms) {
  const m = ms / 60e3;
  if (m < 1) return '<1분';
  if (m < 60) return Math.round(m) + '분';
  const h = m / 60; if (h < 24) return Math.round(h) + '시간';
  const d = h / 24; if (d < 30) return Math.round(d) + '일';
  const mo = d / 30.4; if (mo < 12) return (Math.round(mo * 10) / 10) + '개월';
  return (Math.round(d / 365 * 10) / 10) + '년';
}

// word-level diff for production cards (Antimoon: catch your own mistakes)
export function wordDiff(typed, target) {
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');
  const a = typed.trim().split(/\s+/).filter(Boolean), b = target.trim().split(/\s+/).filter(Boolean);
  const A = a.map(norm), B = b.map(norm);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (A[i] === B[j]) { out.push({ t: 'ok', w: b[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'extra', w: a[i] }); i++; }
    else { out.push({ t: 'miss', w: b[j] }); j++; }
  }
  while (i < a.length) out.push({ t: 'extra', w: a[i++] });
  while (j < b.length) out.push({ t: 'miss', w: b[j++] });
  const correct = out.filter((x) => x.t === 'ok').length;
  return { parts: out, score: b.length ? correct / b.length : 0, perfect: out.every((x) => x.t === 'ok') };
}

// ---- CSV / TSV parsing ----
export function parseDelimited(text) {
  text = text.replace(/^﻿/, '');
  // Anki exports start with "#separator:tab" etc.; otherwise sniff the first non-comment line
  const lines = text.split(/\r?\n/);
  const sepHdr = lines.find((l) => /^#separator:/i.test(l));
  const named = sepHdr && { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' }[sepHdr.split(':')[1].trim().toLowerCase()];
  const firstLine = lines.find((l) => l.trim() && !l.startsWith('#')) || '';
  const delim = named || (firstLine.includes('\t') ? '\t' : (firstLine.includes(';') && !firstLine.includes(',') ? ';' : ','));
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()) && !(r[0] || '').startsWith('#'));
}

// ---- Workload forecast (Anki "Future Due" + a FSRS simulation of the next months) ----
function dayIndex(settings, t, now) { return Math.round((Date.parse(dayKey(settings, t)) - Date.parse(dayKey(settings, now))) / 86400e3); }
const isActive = (c) => !c.sus && (c.st !== State.New || c.iv);
// real cards: how many come due each day (overdue → today). Suspended / not-yet-introduced new cards excluded.
export function dueForecast(notes, settings, days = 30, now = Date.now()) {
  const out = Array.from({ length: days }, (_, i) => ({ k: dayKey(settings, now + i * 86400e3), review: 0, learn: 0 }));
  let overdue = 0;
  for (const note of notes) {
    if (note.del) continue;
    for (const c of Object.values(note.cards || {})) {
      if (!isActive(c)) continue;
      const due = Math.max(c.due, c.bury || 0);
      const i = Math.max(0, dayIndex(settings, due, now)); if (i >= days) continue;
      if (dayIndex(settings, due, now) < 0) overdue++;
      out[i][c.st === State.Review ? 'review' : 'learn']++;
    }
  }
  return { days: out, overdue };
}
// mulberry32: small seeded RNG so the simulation is the same every time you open the screen
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// Simulate the next `days` days with FSRS: every due card is recalled with probability R (its retrievability),
// you add `newPerDay` new cards a day, at most settings.maxReviews reviews a day (the rest roll over, like the app).
// Day-level model: same-day learning steps are approximated (+1 per new card, +1 per lapse).
export const SIM_EXTRA_NEW = 1, SIM_EXTRA_LAPSE = 1;
export function simulateLoad(notes, settings, { days = 365, newPerDay = settings.newPerDay, seed = 7, now = Date.now() } = {}) {
  const f = fsrs(generatorParameters({ request_retention: settings.retention, maximum_interval: 36500, enable_fuzz: false, enable_short_term: false }));
  const rand = rng(seed); const DAY = 86400e3;
  const t0 = endOfDay(settings, now) - DAY + 12 * 3600e3;           // review "at noon" of each simulated day
  const queue = Array.from({ length: days + 1 }, () => []);
  const retireDays = settings.retireYears ? settings.retireYears * 365 : Infinity;
  for (const note of notes) {
    if (note.del) continue;
    for (const c of Object.values(note.cards || {})) {
      if (!isActive(c)) continue;
      const i = Math.max(0, dayIndex(settings, c.due, now)); if (i >= days) continue;
      const card = unpackCard(c);
      if (c.st === State.New) { card.state = State.New; }      // introduced, first test pending
      queue[i].push(card);
    }
  }
  const out = []; const cap = settings.maxReviews || Infinity;
  for (let d = 0; d < days; d++) {
    const at = new Date(t0 + d * DAY);
    let todo = queue[d]; if (todo.length > cap) { queue[d + 1].push(...todo.slice(cap)); todo = todo.slice(0, cap); }
    const fresh = Array.from({ length: newPerDay }, () => createEmptyCard(at));
    let rv = 0, ag = 0, nw = fresh.length;
    for (const card of [...todo, ...fresh]) {
      const isNew = card.state === State.New;
      const R = isNew ? 1 : f.get_retrievability(card, at, false);
      const pass = isNew ? true : rand() < R;
      rv += 1 + (isNew ? SIM_EXTRA_NEW : 0);
      if (!pass) { ag++; rv += SIM_EXTRA_LAPSE; }
      const next = f.next(card, at, pass ? Rating.Good : Rating.Again).card;
      if (next.scheduled_days >= retireDays) continue;
      const di = d + Math.max(1, Math.round((+next.due - +at) / DAY));
      if (di < days) queue[di].push(next);
    }
    out.push({ rv, ag, n: nw, backlog: queue[d + 1] ? queue[d + 1].length : 0 });
  }
  const avg = (a, b) => { const s = out.slice(a, b); return s.length ? s.reduce((x, y) => x + y.rv, 0) / s.length : 0; };
  return { days: out, first: avg(0, 7), m1: avg(23, 37), m3: avg(83, 97), y1: avg(Math.max(0, days - 14), days), peak: Math.max(0, ...out.map((x) => x.rv)) };
}
