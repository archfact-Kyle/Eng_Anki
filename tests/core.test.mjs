// Unit tests for the scheduling/card logic (no browser). Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS as S, makeNote, buildQueues, pickNext, answer, newCardState, Rating, State,
  clozeNumbers, renderCloze, splitSentences, wordDiff, parseDelimited, isLeechHit, trueRetention, dayKey, slowThresholdMs,
  daySplit, reviewHistory, studyRate, estimateMs, fmtDuration, dueForecast, simulateLoad,
} from '../src/core.js';

const DAY = 86400e3;
const reviewCard = (o = {}) => ({ due: Date.now() - DAY, s: 10, d: 5, ed: 0, sd: 10, r: 5, l: 0, ls: 0, st: State.Review, lr: Date.now() - 11 * DAY, ...o });

test('sentence note: rec card, prod only when asked and Korean present', () => {
  assert.deepEqual(Object.keys(makeNote({ text: 'Hi there.' }, S).cards), ['rec']);
  assert.deepEqual(Object.keys(makeNote({ text: 'Hi there.', ko: '안녕', prod: true }, S).cards).sort(), ['prod', 'rec']);
  assert.deepEqual(Object.keys(makeNote({ text: 'Hi there.', prod: true }, S).cards), ['rec']);
});

test('cloze note: one card per cN, focus sentence detected', () => {
  const n = makeNote({ text: 'A {{c1::cat}} sat. The {{c2::dog}} ran away! End.' }, S);
  assert.equal(n.type, 'cloze');
  assert.deepEqual(clozeNumbers(n.text), [1, 2]);
  assert.equal(splitSentences(n.text).length, 3);
  const r = renderCloze(n.text, 2, 'front');
  assert.equal(r.targetSentence, 'The dog ran away!');
  assert.match(r.html, /\[…\]/);
});

test('prod card waits until its rec card has been seen (Antimoon: produce only what you have seen)', () => {
  const n = makeNote({ text: 'Hi.', ko: '안녕', prod: true }, S);
  let q = buildQueues([n], S, {});
  assert.deepEqual(q.fresh.map((x) => x.key), ['rec']);
  n.cards.rec = reviewCard({ due: Date.now() + 5 * DAY });
  q = buildQueues([n], S, {});
  assert.deepEqual(q.fresh.map((x) => x.key), ['prod']);
});

test('learning flood (≥ learnCap) stops new cards', () => {
  const notes = [];
  for (let i = 0; i < S.learnCap; i++) notes.push({ id: 'l' + i, c: i, cards: { rec: { ...newCardState(), st: State.Learning, due: Date.now() + 60e3 } } });
  notes.push({ id: 'n', c: 999, cards: { rec: newCardState() } });
  const q = buildQueues(notes, S, {});
  assert.equal(q.learnFlood, true);
  assert.equal(q.fresh.length, 0);
});

test('backlog: most-likely-remembered first when overdue exceeds daily cap', () => {
  const notes = [];
  for (let i = 0; i < 10; i++) notes.push({ id: 'b' + i, c: i, cards: { rec: reviewCard({ s: 1 + i * 10, due: Date.now() - (3 + i) * DAY, lr: Date.now() - (5 + i * 2) * DAY }) } });
  const q = buildQueues(notes, { ...S, maxReviews: 4 }, {});
  assert.equal(q.backlog, true);
  assert.equal(q.order, 'retrievability');
  assert.equal(q.review.length, 4);
  for (let i = 1; i < q.review.length; i++) assert.ok(q.review[i - 1].R >= q.review[i].R);
});

test('introduced new card waits in learning queue and is not re-introduced', () => {
  const card = { ...newCardState(), iv: Date.now(), due: Date.now() + 60e3 };
  const q = buildQueues([{ id: 'x', c: 1, cards: { rec: card } }], S, {});
  assert.equal(q.fresh.length, 0);
  assert.equal(q.laterLearn.length, 1);
});

test('answer keeps flags; Hard on a review card gives a shorter interval than Good', () => {
  const c = reviewCard({ s: 30, sd: 30, lr: Date.now() - 31 * DAY, sus: 'x', fd: '2026-01-01', fc: 1 });
  const good = answer(c, Rating.Good, S), hard = answer(c, Rating.Hard, S);
  assert.equal(good.sus, 'x'); assert.equal(good.fc, 1);
  assert.ok(hard.due < good.due);
});

test('leech fires at threshold then every half-threshold', () => {
  assert.deepEqual([4, 5, 6, 7, 8, 9].map((l) => isLeechHit(l, 5)), [false, true, false, false, true, false]);
});

test('true retention ignores days without review-state data', () => {
  const days = { [dayKey(S)]: { tr: 10, trf: 2 }, [dayKey(S, Date.now() - DAY)]: { rv: 5 } };
  assert.deepEqual(trueRetention(days, S), { count: 10, rate: 0.8 });
});

test('speed threshold: MCD +4s, prod excluded', () => {
  assert.equal(slowThresholdMs('rec', S), 8000);
  assert.equal(slowThresholdMs('c3', S), 12000);
  assert.equal(slowThresholdMs('prod', S), null);
});

test('wordDiff marks missing and extra words', () => {
  const d = wordDiff('I run out time', 'I ran out of time');
  assert.equal(d.perfect, false);
  assert.ok(d.parts.some((p) => p.t === 'miss' && p.w === 'of'));
});

test('parseDelimited: TSV, quoted CSV, comments', () => {
  assert.deepEqual(parseDelimited('#c\nA\tB\n'), [['A', 'B']]);
  assert.deepEqual(parseDelimited('"Hello, world",안녕\n'), [['Hello, world', '안녕']]);
  // our own Anki export: header lines first, commas inside fields must survive
  assert.deepEqual(parseDelimited('#separator:tab\n#html:true\nI ran out, sadly.\t뜻, 여러 개\n'), [['I ran out, sadly.', '뜻, 여러 개']]);
});

test('pickNext prefers learning, then mixes new after N reviews', () => {
  const mk = (id, card) => ({ note: { id }, key: 'rec', card });
  const q = { learn: [], review: [mk('r1', reviewCard()), mk('r2', reviewCard())], fresh: [mk('n1', newCardState())], laterLearn: [] };
  assert.equal(pickNext(q, S, 0, null).note.id, 'r1');
  assert.equal(pickNext(q, S, S.newMix, null).note.id, 'n1');
});

test('daySplit: new / again / young / mature add up to rv; old days without new fields still work', () => {
  assert.deepEqual(daySplit({ rv: 10, n: 2, ag: 1, mt: 4, ms: 50e3, tc: 10 }), { n: 2, ag: 1, mt: 4, young: 3, rv: 10, ms: 50e3, tc: 10 });
  assert.deepEqual(daySplit({ rv: 5, n: 1, ag: 0 }), { n: 1, ag: 0, mt: 0, young: 4, rv: 5, ms: 0, tc: 0 });
  assert.equal(daySplit(undefined).rv, 0);
});

test('reviewHistory: days studied, averages, time, buckets end today', () => {
  const now = Date.parse('2026-11-20T12:00:00');
  const k = (i) => dayKey(S, now - i * DAY);
  const days = { [k(0)]: { rv: 10, n: 0, ag: 1, ms: 60e3, tc: 10 }, [k(2)]: { rv: 20, n: 5, ag: 2, mt: 3 }, [k(9)]: { rv: 30, n: 30, ag: 0 } };
  const h = reviewHistory(days, S, 30, now);
  assert.equal(h.buckets.length, 30); assert.equal(h.bucketDays, 1);
  assert.equal(h.buckets[29].start, k(0)); assert.equal(h.buckets[29].rv, 10); assert.equal(h.buckets[27].mt, 3);
  assert.equal(h.total, 60); assert.equal(h.studied, 3);
  assert.equal(h.period, 10);                         // first study 9 days ago → 10-day period, not 30
  assert.equal(h.avgStudied, 20); assert.equal(h.avgPeriod, 6);
  assert.equal(h.totalMs, 60e3); assert.equal(h.avgAnswerMs, 6e3); assert.equal(h.timedDays, 1);
  assert.equal(h.buckets[29].cum, 60);
  const y = reviewHistory(days, S, 365, now);         // weekly buckets, last one holds today
  assert.equal(y.bucketDays, 7); assert.equal(y.buckets.at(-1).rv, 30); assert.equal(y.total, 60);
  const all = reviewHistory(days, S, 0, now);
  assert.equal(all.len, 10); assert.equal(all.total, 60);
  assert.equal(reviewHistory({}, S, 0, now).total, 0);
});

test('studyRate and time estimate (falls back until 20 timed answers)', () => {
  const now = Date.parse('2026-11-20T12:00:00');
  const days = {}; for (let i = 0; i < 10; i += 2) days[dayKey(S, now - i * DAY)] = { rv: 5, n: 0, ag: 0, ms: 25e3, tc: 5 };
  const r = studyRate(days, S, 30, now); assert.equal(r.studied, 5); assert.equal(r.period, 9);
  const e = estimateMs(10, days, S, 10e3, now); assert.equal(e.measured, true); assert.equal(e.per, 5e3); assert.equal(e.ms, 50e3);
  assert.equal(estimateMs(10, {}, S, 10e3, now).measured, false);
  assert.equal(fmtDuration(30e3), '30초'); assert.equal(fmtDuration(25 * 60e3), '25분'); assert.equal(fmtDuration(3 * 86400e3), '3일');
});

test('dueForecast: overdue counts today, suspended and un-introduced new cards excluded', () => {
  const now = Date.parse('2026-11-20T12:00:00');
  const n = (id, cards) => ({ id, type: 'sent', text: id, c: 1, cards });
  const notes = [
    n('a', { rec: reviewCard({ due: now - 3 * DAY }) }),                  // overdue → today
    n('b', { rec: reviewCard({ due: now + 2 * DAY }) }),
    n('c', { rec: reviewCard({ due: now + 2 * DAY, sus: 'leech' }) }),
    n('d', { rec: { ...newCardState(new Date(now)) } }),                  // never shown: not a review yet
    n('e', { rec: { ...newCardState(new Date(now)), iv: now, due: now + 60e3 } }), // introduced → first test today
    n('f', { rec: reviewCard({ due: now + 40 * DAY }) }),                 // outside the window
  ];
  const f = dueForecast(notes, S, 30, now);
  assert.equal(f.days.length, 30); assert.equal(f.overdue, 1);
  assert.deepEqual([f.days[0].review, f.days[0].learn], [1, 1]);
  assert.equal(f.days[2].review, 1);
  assert.equal(f.days.reduce((a, d) => a + d.review + d.learn, 0), 3);
});

test('simulateLoad: deterministic, more new cards → more reviews, daily cap respected', () => {
  const now = Date.parse('2026-11-20T12:00:00');
  const notes = []; for (let i = 0; i < 300; i++) notes.push({ id: 'n' + i, type: 'sent', text: 'x', c: i, cards: { rec: reviewCard({ due: now + (i % 30) * DAY, s: 5 + i % 50, sd: 5 + i % 50, lr: now - 10 * DAY }) } });
  const a = simulateLoad(notes, S, { days: 120, newPerDay: 0, now });
  const b = simulateLoad(notes, S, { days: 120, newPerDay: 0, now });
  assert.deepEqual(a.days.map((d) => d.rv), b.days.map((d) => d.rv));           // seeded → same result every open
  const c = simulateLoad(notes, S, { days: 120, newPerDay: 20, now });
  assert.ok(c.m3 > a.m3 + 50, `20 new/day should add load (${c.m3} vs ${a.m3})`);
  assert.ok(a.m3 < a.first, 'with no new cards the load shrinks as intervals grow');
  const capped = simulateLoad(notes.map((x) => ({ ...x, cards: { rec: { ...x.cards.rec, due: now - DAY } } })), { ...S, maxReviews: 50 }, { days: 10, newPerDay: 0, now });
  assert.ok(capped.days[0].rv <= 50 * 2 && capped.days[0].backlog > 0, 'overflow rolls to the next day');
});
