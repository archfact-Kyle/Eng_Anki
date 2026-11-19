// End-to-end tests on an iPhone-sized viewport (Chromium). Run: npm run test:e2e
import { test, expect } from '@playwright/test';

const DAY = 86400e3;

// Read every note's cards (and meta) straight from IndexedDB.
// The app debounces local writes by 250 ms, so give it a moment first.
async function readDB(page, settle = 500) {
  await page.waitForTimeout(settle);
  return page.evaluate(() => new Promise((res) => {
    const q = indexedDB.open('ankiwords');
    q.onsuccess = () => {
      const out = {}; const cur = q.result.transaction('kv').objectStore('kv').openCursor();
      cur.onsuccess = () => {
        const x = cur.result;
        if (!x) return res(out);
        if (x.key === 'meta') out._meta = x.value;
        else for (const [id, n] of Object.entries(x.value.notes)) if (!n.del) out[id] = n;
        x.continue();
      };
    };
  }));
}
// Restore a crafted backup through the UI (also exercises the paste-import path).
async function restore(page, notes, settings = {}) {
  await page.click('nav button[data-v=settings]');
  await page.fill('#imp-text', JSON.stringify({ app: 'ankiwords', v: 1, exported: 'test', meta: { settings, days: {} }, notes }));
  await page.click('[data-act=imp-paste]');
  await page.click('[data-ok]');
}
const sent = (id, text, cards, c = 1) => ({ id, text, ko: '뜻', extra: '', src: '', tags: [], c, type: 'sent', cards, u: Date.now() });
const reviewCard = (now, o = {}) => ({ due: now - DAY, s: 30, d: 5, ed: 0, sd: 30, r: 5, l: 0, ls: 0, st: 2, lr: now - 31 * DAY, ...o });
const newCard = (now) => ({ due: now, s: 0, d: 0, ed: 0, sd: 0, r: 0, l: 0, ls: 0, st: 0, lr: null });

test('sample deck → intro → review loop works without errors', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.click('[data-act=sample]');
  await page.click('nav button[data-v=review]');
  await expect(page.locator('.intro')).toBeVisible();          // new cards are introduced first
  for (let i = 0; i < 25; i++) {
    if (await page.locator('.intro').count()) { await page.click('[data-act=intro-ok]'); continue; }
    if (!(await page.locator('.face').count())) break;
    await page.click('[data-act=show]');
    await page.click('[data-grade="3"]');
  }
  await page.click('nav button[data-v=home]');
  await expect(page.locator('.nums')).toBeVisible();
  expect(errors).toEqual([]);
});

test('MCD: tapping words makes one cloze per phrase', async ({ page }) => {
  await page.goto('/');
  await page.click('nav button[data-v=add]');
  await page.click('[data-mode=mcd]');
  await page.fill('#m-text', 'The engine was running smoothly. The pilot noticed a slight vibration.');
  await page.click('[data-act=mcd-next]');
  for (const w of ['smoothly.', 'slight', 'vibration.']) await page.locator('[data-tok]', { hasText: new RegExp('^' + w.replace('.', '\\.') + '$') }).click();
  await expect(page.locator('[data-act=add-mcd]')).toHaveText('카드 2장 만들기');
  await page.click('[data-act=add-mcd]');
  const db = await readDB(page);
  const note = Object.values(db).find((n) => n.type === 'cloze');
  expect(note.text).toBe('The engine was running {{c1::smoothly}}. The pilot noticed a {{c2::slight vibration}}.');
});

test('backup export → wipe → import restores scheduling exactly', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-act=sample]');
  await page.click('nav button[data-v=settings]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act=exp-json]')]);
  const file = await dl.path();
  const before = await readDB(page);
  await page.click('[data-act=wipe]'); await page.click('[data-ok]');
  await page.click('nav button[data-v=settings]');
  await page.setInputFiles('#imp-file', file);
  await page.click('[data-ok]');
  await page.waitForTimeout(400);
  const after = await readDB(page);
  for (const [id, n] of Object.entries(before)) if (id !== '_meta') expect(after[id].cards).toEqual(n.cards);
});

test('ajatt.top rules: leech auto-suspend, retire, backlog banner', async ({ page }) => {
  await page.goto('/');
  const now = await page.evaluate(() => Date.now());
  const notes = [
    sent('retire', 'Retire sentence.', { rec: reviewCard(now, { s: 9000, sd: 3000, lr: now - 3000 * DAY }) }, 1),
    sent('leech', 'Leech sentence.', { rec: reviewCard(now, { s: 900, sd: 300, lr: now - 301 * DAY, l: 4 }) }, 2),
  ];
  for (let i = 0; i < 10; i++) notes.push(sent('b' + i, 'Backlog ' + i + '.', { rec: reviewCard(now, { s: 2 + i, sd: 2 + i, due: now - (5 + i) * DAY, lr: now - (8 + i) * DAY }) }, 10 + i));
  await restore(page, notes, { maxReviews: 5 });
  await page.click('nav button[data-v=home]');
  await expect(page.locator('.note.warn').first()).toContainText('밀린 카드');
  await page.click('nav button[data-v=review]');
  await expect(page.locator('.face')).toContainText('Retire sentence');
  await page.keyboard.press('k');                                   // Good from the front
  await expect(page.locator('#toast')).toContainText('은퇴');
  await expect(page.locator('.face')).toContainText('Leech sentence');
  await page.click('[data-act=show]');
  await expect(page.locator('.answer .grade')).toHaveCount(2);        // two-button mode
  await page.click('[data-grade="1"]');
  await expect(page.locator('#toast')).toContainText('리치');
  const db = await readDB(page);
  expect(db.retire.cards.rec.sus).toBe('retired');
  expect(db.leech.cards.rec.sus).toBe('leech');
});

test('speed grading: slow Good is recorded as Hard', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  const now = await page.evaluate(() => Date.now());
  await restore(page, [sent('slow', 'Slow one.', { rec: reviewCard(now) }, 1), sent('quick', 'Quick one.', { rec: reviewCard(now, { due: now - 2 * DAY }) }, 2)]);
  await page.click('nav button[data-v=review]');
  const first = (await page.locator('.face').textContent()).includes('Quick') ? 'quick' : 'slow';
  for (const which of [first, first === 'quick' ? 'slow' : 'quick']) {
    await page.clock.runFor(which === 'slow' ? 11_000 : 2_000);
    await page.click('[data-act=show]');
    if (which === 'slow') await expect(page.locator('.slowmsg')).toBeVisible();
    else await expect(page.locator('.slowmsg')).toHaveCount(0);
    await page.click('[data-grade="3"]');
  }
  await page.clock.runFor(1500);
  const db = await readDB(page);
  const ivl = (c) => (c.due - c.lr) / DAY;
  expect(ivl(db.slow.cards.rec)).toBeLessThan(ivl(db.quick.cards.rec));
});

test('new-card intro: "이미 알아요" suspends, "익혔어요" schedules 1 minute later', async ({ page }) => {
  await page.goto('/');
  const now = await page.evaluate(() => Date.now());
  await restore(page, [sent('a', 'Learn me.', { rec: newCard(now) }, 1), sent('b', 'Known already.', { rec: newCard(now) }, 2)]);
  await page.click('nav button[data-v=review]');
  await expect(page.locator('.intro')).toContainText('Learn me');
  await page.click('[data-act=intro-ok]');
  await expect(page.locator('.intro')).toContainText('Known already');
  await page.click('[data-act=intro-known]');
  await page.waitForTimeout(400);
  const db = await readDB(page);
  expect(db.a.cards.rec.iv).toBeTruthy();
  expect(db.a.cards.rec.due - db.a.cards.rec.iv).toBe(60_000);
  expect(db.b.cards.rec.sus).toBe('known');
});

test('TTS skips novelty voices and prefers Premium', async ({ page }) => {
  await page.addInitScript(() => {
    const vs = [['Albert', 'en-US', 'com.apple.speech.synthesis.voice.Albert'], ['Zarvox', 'en-US', 'x.Zarvox'],
      ['Grandpa (영어(미국))', 'en-US', 'com.apple.eloquence.en-US.Grandpa'], ['Samantha', 'en-US', 'com.apple.voice.compact.en-US.Samantha'],
      ['Ava (Premium)', 'en-US', 'com.apple.voice.premium.en-US.Ava']].map(([name, lang, voiceURI]) => ({ name, lang, voiceURI }));
    window.__spoken = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => vs, speak: (u) => window.__spoken.push(u.voice && u.voice.name), cancel() {} } });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  });
  await page.goto('/');
  await page.click('nav button[data-v=settings]');
  const options = await page.locator('select[data-set=ttsVoice] option').allTextContents();
  expect(options.join('|')).not.toMatch(/Albert|Zarvox|Grandpa/);
  await page.click('[data-act=tts-test]');
  expect(await page.evaluate(() => window.__spoken)).toEqual(['Ava (Premium)']);
});

test.describe('recorder', () => {
  // fake microphone is enabled for all tests in playwright.config.js
  test('record then play back own voice', async ({ page }) => {
    await page.goto('/');
    const now = await page.evaluate(() => Date.now());
    await restore(page, [sent('r', 'Say this.', { rec: reviewCard(now) })]);
    await page.click('nav button[data-v=review]');
    await page.click('[data-act=show]');
    await page.click('[data-act=rec]');
    await expect(page.locator('#recbar')).toContainText('정지');
    await page.waitForTimeout(600);
    await page.click('[data-act=rec]');
    await expect(page.locator('[data-act=rec-play]')).toBeVisible();
  });
});
