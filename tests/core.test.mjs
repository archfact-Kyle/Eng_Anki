// Unit tests for the scheduling/card logic (no browser). Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS as S, makeNote, buildQueues, pickNext, answer, newCardState, Rating, State,
  clozeNumbers, renderCloze, splitSentences, wordDiff, parseDelimited, isLeechHit, trueRetention, dayKey, slowThresholdMs,
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
