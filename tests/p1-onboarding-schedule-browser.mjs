import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './lib/contained-playwright.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const login = read('login.html');
const joinSource = read('join-ui.js');
const schedule = read('schedule-management.js');
const browser = await chromium.launch(process.env.RESQ_CHROMIUM
  ? { headless:true, executablePath:process.env.RESQ_CHROMIUM } : { headless:true });
let passed = 0;
function check(name, condition) { assert.ok(condition, name); passed++; console.log('PASS ' + name); }

function contrast(hexA, hexB) {
  const luminance = (hex) => {
    const rgb = hex.match(/[0-9a-f]{2}/gi).slice(0, 3).map((part) => parseInt(part, 16) / 255);
    const linear = rgb.map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  };
  const values = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}
function rgbHex(value) {
  const rgb = value.match(/\d+/g)?.slice(0, 3).map(Number) || [];
  return '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('');
}

try {
  const page = await browser.newPage({ viewport:{ width:320, height:740 }, locale:'he-IL' });
  const html = login.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*href=["'][^"']+\.css(?:\?[^"']*)?["'][^>]*>/gi, '');
  await page.setContent(html);
  await page.addStyleTag({ content:read('theme.css') });
  await page.evaluate(() => {
    document.body.classList.add('art', 'ready');
    document.getElementById('joinPanel').classList.remove('hide');
  });
  const exports = [...joinSource.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  await page.addScriptTag({ type:'module', content:joinSource.replace(/^export (const|function) /gm, '$1 ') +
    '\nwindow.JoinUI = { ' + exports.join(', ') + ' };' });
  await page.waitForFunction(() => !!window.JoinUI);
  await page.evaluate(() => {
    window.joinUser = null;
    window.joinPanelTest = JoinUI.createJoinPanel(document.getElementById('joinPanel'), {
      token:'AAAAAAAAAAAAAAAA.' + 'B'.repeat(43),
      inspect:async () => ({ state:'active', station_name:'אילת', allowed_shifts:['A','B','C'],
        qualification_catalog:[{ key:'driver', label:'נהג' }] }),
      redeem:async () => ({ ok:true }), currentUser:() => window.joinUser,
      createAccount:async () => {}, signIn:async () => {}, requestPasswordReset:async () => {},
      sendVerification:async () => {}, refreshUser:async () => {}, hasAssignment:() => false,
      onRedeemed:async () => {}, pwOk:() => true, claims:async () => ({})
    });
    window.joinPanelTest.load();
  });
  await page.waitForSelector('#joinForm');
  const colors = await page.locator('#joinPanel').evaluate((panel) => {
    const selectors = ['#joinTitle', '#joinPanel .join-hint', '#joinPanel .join-step h3',
      '#joinPanel button.ghost', '#joinPanel .join-legal-doc p', '#joinPanel .join-legal-doc summary'];
    return selectors.map((selector) => ({ selector, color:getComputedStyle(document.querySelector(selector)).color }));
  });
  for (const item of colors) {
    check('join contrast ' + item.selector,
      contrast(rgbHex(item.color), '#161b2a') >= 4.5);
  }
  await page.locator('#joinEmail').fill('worker@example.invalid');
  await page.locator('#joinPassword').fill('Password123');
  await page.locator('#joinName').fill('עובד בדיקה');
  await page.locator('#joinPhone').fill('050-1234567');
  await page.locator('#joinNote').fill('הערה לטופס');
  await page.locator('#joinShift_C').check();
  await page.locator('#joinQual_driver').check();
  await page.locator('#joinQual_driver_until').fill('2030-01-01');
  await page.locator('#joinQual_driver_ref').fill('רישיון C');
  await page.locator('#joinAck').check();
  await page.evaluate(() => window.joinPanelTest.rerender());
  check('token rerender keeps unsent choices in memory', await page.evaluate(() =>
    document.getElementById('joinName').value === 'עובד בדיקה' &&
    document.getElementById('joinPhone').value === '050-1234567' &&
    document.getElementById('joinNote').value === 'הערה לטופס' &&
    document.getElementById('joinShift_C').checked &&
    document.getElementById('joinQual_driver').checked &&
    document.getElementById('joinQual_driver_until').value === '2030-01-01' &&
    document.getElementById('joinQual_driver_ref').value === 'רישיון C'));
  check('password and legal acknowledgement are not restored', await page.evaluate(() =>
    document.getElementById('joinPassword').value === '' && !document.getElementById('joinAck').checked));
  check('pre-auth update guard covers every populated join field',
    ['joinEmail','joinPassword','joinName','joinPhone','joinNote'].every((id) =>
      login.match(/const protectedIds = \[([\s\S]*?)\];/)?.[1].includes("'" + id + "'")));
  await page.close();

  const guardPage = await browser.newPage();
  await guardPage.setContent('<div id="authView"><div id="joinPanel"><form id="joinForm">' +
    '<input id="joinName"><input id="joinQual_driver" type="checkbox">' +
    '<input id="joinShift_A" name="joinShift" type="radio" checked>' +
    '<input id="joinShift_B" name="joinShift" type="radio">' +
    '<input id="joinAck" type="checkbox"></form></div></div><div id="homeView" class="hide"></div>');
  const guardStart = login.indexOf("['input', 'change'].forEach(function (type) {");
  const guardEnd = login.indexOf('initPWA({ offer: true });', guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart, 'login update guard can be exercised');
  await guardPage.addScriptTag({ content:
    'const $ = (id) => document.getElementById(id);' +
    'let authSettled=true, onboarding=false, loginTransitionPending=false;' +
    'function registerPwaUpdateGuard(guard) { window.checkUpdate = guard; }' +
    login.slice(guardStart, guardEnd) });
  check('untouched join form permits manual update', await guardPage.evaluate(() => window.checkUpdate() === true));
  await guardPage.locator('#joinQual_driver').check();
  check('qualification-only draft blocks update', await guardPage.evaluate(() => window.checkUpdate() !== true));
  await guardPage.evaluate(() => { document.getElementById('joinPanel').dataset.joinDraftDirty = ''; });
  await guardPage.locator('#joinShift_B').check();
  check('shift-only draft blocks update', await guardPage.evaluate(() => window.checkUpdate() !== true));
  await guardPage.evaluate(() => { document.getElementById('joinPanel').dataset.joinDraftDirty = ''; });
  await guardPage.locator('#joinAck').check();
  check('acknowledgement-only draft blocks update', await guardPage.evaluate(() => window.checkUpdate() !== true));
  await guardPage.locator('#joinForm').evaluate((form) => { form.innerHTML = '<input id="joinName">'; });
  check('form rerender cannot erase the dirty guard', await guardPage.evaluate(() => window.checkUpdate() !== true));
  await guardPage.evaluate(() => { document.getElementById('joinPanel').classList.add('hide'); });
  check('hidden join form does not block update', await guardPage.evaluate(() => window.checkUpdate() === true));
  await guardPage.close();

  const boardPage = await browser.newPage({ viewport:{ width:320, height:740 } });
  await boardPage.setContent('<html dir="rtl"><style>#board{direction:rtl;width:320px;overflow:auto;--dayw:80px}#wide{width:2800px;height:20px}</style><div id="head"></div><div id="board"><div id="wide"></div></div></html>');
  const start = schedule.indexOf('function renderBoardHead(');
  const end = schedule.indexOf('/* ⭐', start);
  assert.ok(start >= 0 && end > start, 'schedule source contains renderBoardHead');
  await boardPage.addScriptTag({ content:
    'const MONTHS = Array(12).fill("חודש");' +
    'const node = (tag, cls, text) => { const n=document.createElement(tag); n.className=cls; n.textContent=text; return n; };' +
    'const clear = (n) => n.replaceChildren(); const $ = (id) => document.getElementById(id);' +
    schedule.slice(start, end) });
  await boardPage.evaluate(() => renderBoardHead(document.getElementById('head'), '2026-09', () => {}, 'board', 'week'));
  await boardPage.getByRole('button', { name:'שבוע הבא' }).click();
  await boardPage.waitForFunction(() => document.getElementById('board').scrollLeft < -100);
  const nextScroll = await boardPage.locator('#board').evaluate((n) => n.scrollLeft);
  check('RTL next week moves to later dates', nextScroll < -100);
  await boardPage.getByRole('button', { name:'שבוע קודם' }).click();
  await boardPage.waitForFunction((before) => document.getElementById('board').scrollLeft > before + 100, nextScroll);
  check('RTL previous week moves back', true);
  await boardPage.close();
} finally {
  await browser.close();
}
console.log('PASS p1-onboarding-schedule-browser', passed);
