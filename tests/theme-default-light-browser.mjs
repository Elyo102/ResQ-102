/**
 * 42H.20 §2 · ResQ עוברת לערכה הבהירה כברירת מחדל לכולם, ומצב כהה/בהיר
 * של המכשיר בלבד (בלי בחירה ידנית ב-nav.js) כבר לא אמור לשנות דבר.
 *
 * הבדיקה הזאת הייתה נכשלת לפני התיקון: בלי data-theme, מכשיר שמוגדר
 * ל-dark קיבל את הפלטה הכהה (theme.css :root היה כהה כברירת מחדל),
 * ומכשיר עם prefers-color-scheme: light קיבל בהיר — שני מראות שונים
 * לאותו עמוד, בלי בחירה של המשתמש. אחרי התיקון שניהם זהים לבהיר,
 * ורק data-theme="dark" מפורש (הבחירה הידנית ב-nav.js) מציג כהה.
 *
 * רץ על Chromium דרך Playwright. שני העמודים היחידים עם ערכה מקומית
 * משלהם (schedule-management.html, callout.html) נבדקים בנפרד
 * מ-theme.css הכללי כי הם נושאים משתנים מקומיים משלהם
 * (--manager-heading / --callout-heading) שהיו כפופים לאותו באג.
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const EXEC = '/opt/pw-browsers/chromium';

async function launch() {
  try { return await chromium.launch({ executablePath: EXEC }); }
  catch (e) { return await chromium.launch(); }
}

let pass = 0;
const fails = [];
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('✓ ' + name); }
  catch (e) { fails.push(name + ' → ' + (e && e.message)); console.log('✗ ' + name, e && e.message); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

const browser = await launch();

async function computedVar(page, name) {
  return page.evaluate((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(), name);
}

await t('a plain page with only theme.css ignores device dark/light with no explicit choice', async () => {
  const ctxLight = await browser.newContext({ colorScheme: 'light' });
  const ctxDark = await browser.newContext({ colorScheme: 'dark' });
  const pageLight = await ctxLight.newPage();
  const pageDark = await ctxDark.newPage();
  await pageLight.goto('file://' + join(root, 'login.html'));
  await pageDark.goto('file://' + join(root, 'login.html'));
  const bgLight = await computedVar(pageLight, '--bg');
  const bgDark = await computedVar(pageDark, '--bg');
  ok(bgLight === bgDark, 'device scheme changed --bg with no explicit choice: ' + bgLight + ' vs ' + bgDark);
  // 42H.20 Scope 10 (closure batch item 5): theme.css's shared --bg moved
  // to the same approved #eef2f6 that schedule-management.html and
  // callout.html's own local overrides already used below - the exact
  // divergence this file's own docstring used to document is now closed.
  ok(bgLight === '#eef2f6', 'default --bg is not the approved light value: ' + bgLight);
  await ctxLight.close(); await ctxDark.close();
});

await t('explicit data-theme="dark" still produces the original dark palette', async () => {
  const page = await browser.newPage();
  await page.goto('file://' + join(root, 'login.html'));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const bg = await computedVar(page, '--bg');
  ok(bg === '#15171a', 'explicit dark did not restore the original dark background: ' + bg);
  await page.close();
});

for (const { file, headingVar } of [
  { file: 'schedule-management.html', headingVar: '--manager-heading' },
  { file: 'callout.html', headingVar: '--callout-heading' }
]) {
  await t(file + ': page-local light override no longer depends on device scheme', async () => {
    const ctxLight = await browser.newContext({ colorScheme: 'light' });
    const ctxDark = await browser.newContext({ colorScheme: 'dark' });
    const pageLight = await ctxLight.newPage();
    const pageDark = await ctxDark.newPage();
    await pageLight.goto('file://' + join(root, file));
    await pageDark.goto('file://' + join(root, file));
    const bgLight = await computedVar(pageLight, '--bg');
    const bgDark = await computedVar(pageDark, '--bg');
    const headLight = await computedVar(pageLight, headingVar);
    const headDark = await computedVar(pageDark, headingVar);
    ok(bgLight === bgDark, file + ': --bg differs by device scheme: ' + bgLight + ' vs ' + bgDark);
    ok(headLight === headDark, file + ': ' + headingVar + ' differs by device scheme');
    ok(bgLight === '#eef2f6', file + ': default --bg is not the approved light value: ' + bgLight);
    await ctxLight.close(); await ctxDark.close();
  });

  await t(file + ': explicit data-theme="dark" restores the original heading color', async () => {
    const page = await browser.newPage();
    await page.goto('file://' + join(root, file));
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const head = await computedVar(page, headingVar);
    ok(head === '#e8eaed', file + ': ' + headingVar + ' under explicit dark is not var(--txt): ' + head);
    await page.close();
  });
}

await browser.close();
if (fails.length) { console.error(fails.length + ' failed'); process.exitCode = 1; }
else console.log(pass + '/' + pass + ' theme default-light checks passed');
