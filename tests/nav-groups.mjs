import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const fixture = `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<!-- ⭐ הפלטה האמיתית, ולא עותק שלה.
     עד כאן הקובץ הזה נשא תת-קבוצה מועתקת של המשתנים, ולכן טוקן חדש
     ב-theme.css פשוט לא היה קיים בבדיקה — והיא הייתה עוברת על צבע
     ברירת מחדל בזמן שבמסך האמיתי הצבע נכון (או להפך). הבלוק שמתחת
     נשאר כדי לדרוס במפורש מה שהבדיקה רוצה לשלוט בו. -->
<link rel="stylesheet" href="/theme.css">
<style>
:root{--card:#fff;--line:#ddd;--line-hover:#ccc;--txt:#182033;--dim:#556070;
--muted:#788291;--accent:#e8590c;--accent-txt:#b64000;--on-accent:#fff;--accent-on:#000;--chip:#f6f7f9}
:root[data-theme="dark"]{--card:#111827;--line:#334155;--line-hover:#475569;
--txt:#f8fafc;--dim:#cbd5e1;--muted:#94a3b8;--accent:#fb7b32;
--accent-txt:#ffad7a;--on-accent:#111827;--accent-on:#111827;--chip:#1f2937}
body{margin:18px;font-family:Segoe UI,Arial,sans-serif;background:var(--card);color:var(--txt)}
</style></head><body><main id="content">תוכן בדיקה</main>
<script type="module">
import { renderNav, applyTheme } from '/nav.js';
const params = new URLSearchParams(location.search);
const claims = JSON.parse(params.get('claims') || '{}');
renderNav(claims, params.get('current') || 'attendance.html', 'בדיקה');
window.__applyTheme = applyTheme;
window.__renderNav = renderNav;
window.__navReady = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  if (pathname === '/__nav-test.html') {
    res.writeHead(200, { 'Content-Type': mime['.html'] });
    res.end(fixture);
    return;
  }
  const file = path.join(root, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain; charset=utf-8' });
  res.end(fs.readFileSync(file));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/__nav-test.html';
const browser = await chromium.launch();
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS', name);
  } catch (error) {
    failures.push(name + ': ' + error.message);
    console.error('FAIL', name);
    console.error('  ' + error.message);
  }
}

function same(actual, expected, label) {
  const a = actual.slice().sort();
  const e = expected.slice().sort();
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    throw new Error(label + '\n  expected ' + JSON.stringify(e) + '\n  actual   ' + JSON.stringify(a));
  }
}

const member = [
  'login.html', 'schedule-management.html', 'board.html', 'attendance.html', 'guards.html',
  'faults.html', 'forms.html', 'sign.html', 'swaps.html', 'feedback.html', 'quals.html',
  'alerts.html', 'people.html', 'hr-requests.html', 'hr-documents.html'
];
const staff = member.concat(['access.html', 'admin.html', 'stats.html']);
const audit = staff.concat(['attendance-shadow.html']);
const all = audit.concat(['hr.html', 'import.html', 'check.html', 'maintenance.html', 'callout.html', 'saas-admin.html', 'metrics.html']);
const roles = [
  ['firefighter', { role:'firefighter' }, member, 2],
  ['deputy_team_leader', { role:'deputy_team_leader' }, member, 2],
  ['team_leader', { role:'team_leader' }, member, 2],
  ['deputy', { role:'deputy' }, staff.concat(['callout.html']), 3],
  ['commander', { role:'commander' }, staff.concat(['callout.html']), 3],
  ['station_commander', { role:'station_commander' }, audit, 3],
  ['hr_coordinator', { role:'hr_coordinator' }, audit.concat(['hr.html']), 3],
  ['string_super', { role:'firefighter', super:'true' }, member, 2],
  ['role_email_super', { role:'super_admin', email:'synthetic@example.invalid' }, ['login.html'], 1],
  ['district_commander', { role:'district_commander' }, ['login.html'], 1],
  ['super', { role:'firefighter', super:true }, all, 3]
];

async function open(context, claims, current = 'attendance.html') {
  const page = await context.newPage();
  const query = new URLSearchParams({ claims:JSON.stringify(claims), current });
  await page.goto(base + '?' + query, { waitUntil:'load' });
  await page.waitForFunction(() => window.__navReady === true);
  return page;
}

try {
  const midWidth = await browser.newContext({ viewport:{ width:600, height:844 }, locale:'he-IL' });
  const midPage = await open(midWidth, { role:'firefighter', super:true });
  await test('600px uses compact header with dock rather than duplicate expanded navigation', async () => {
    if (!await midPage.locator('#navToggle').isVisible()) throw new Error('compact toggle missing at 600px');
    if (await midPage.locator('#navLinks').isVisible()) throw new Error('600px navigation starts expanded');
    if (!await midPage.locator('#resqDock').isVisible()) throw new Error('600px dock missing');
    await midPage.locator('#navToggle').click();
    if (!await midPage.locator('#navLinks').isVisible()) throw new Error('600px menu cannot open');
    await midPage.keyboard.press('Escape');
    if (await midPage.locator('#navLinks').isVisible()) throw new Error('600px Escape does not close menu');
    if (await midPage.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('600px overflow');
  });
  await midWidth.close();
  const matrixContext = await browser.newContext({ viewport:{ width:1280, height:800 }, locale:'he-IL' });
  for (const [name, claims, expectedLinks, expectedDoors] of roles) {
    await test(name + ' keeps the exact permitted destinations', async () => {
      const page = await open(matrixContext, claims);
      const hrefs = await page.locator('.navPanel a').evaluateAll(nodes =>
        nodes.map(node => new URL(node.href).pathname.split('/').pop()));
      same(hrefs, expectedLinks, name + ' destination set changed');
      const doors = await page.locator('button.door').count();
      if (doors !== expectedDoors) throw new Error('expected ' + expectedDoors + ' doors, got ' + doors);
      await page.close();
    });
  }
  await matrixContext.close();

  const commandContext = await browser.newContext({ viewport:{ width:1280, height:800 }, locale:'he-IL' });
  const commandPage = await open(commandContext, { role:'commander' });
  await test('callout is placed under my shift for shift command only', async () => {
    const mine = await commandPage.locator('#panel-mine a').evaluateAll(nodes =>
      nodes.map(node => new URL(node.href).pathname.split('/').pop()));
    const station = await commandPage.locator('#panel-station a').evaluateAll(nodes =>
      nodes.map(node => new URL(node.href).pathname.split('/').pop()));
    if (!mine.includes('callout.html')) throw new Error('callout is missing from my shift');
    if (station.includes('callout.html')) throw new Error('callout remained under station');
    if (!station.includes('alerts.html')) throw new Error('member alert settings were removed');
  });
  await commandPage.close();
  await commandContext.close();

  const mobile = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  const mobilePage = await open(mobile, { role:'firefighter' });
  await test('mobile starts collapsed and keeps RTL', async () => {
    if (!await mobilePage.locator('#navToggle').isVisible()) throw new Error('menu toggle is hidden');
    if (await mobilePage.locator('#navLinks').isVisible()) throw new Error('menu starts open');
    const direction = await mobilePage.locator('#appNav').evaluate(el => getComputedStyle(el).direction);
    if (direction !== 'rtl') throw new Error('direction is ' + direction);
  });
  await test('mobile dock exposes direct schedule and hours links plus the permitted groups', async () => {
    await mobilePage.evaluate(() => {
      document.documentElement.style.setProperty('--resq-safe-left-override', '44px');
      document.documentElement.style.setProperty('--resq-safe-right-override', '44px');
    });
    const slots = await mobilePage.locator('#resqDock > *').evaluateAll(nodes => nodes.map(node => ({
      id:node.dataset.dockId, label:node.querySelector('.dockLbl')?.textContent,
      href:node.tagName === 'A' ? new URL(node.href).pathname.split('/').pop() + new URL(node.href).search : null,
      aria:node.getAttribute('aria-label')
    })));
    same(slots.map(slot => slot.id), ['home', 'schedule', 'hours', 'station', 'more'], 'mobile dock slots changed');
    same(slots.map(slot => slot.label), ['בית', 'סידור', 'שעות', 'התחנה', 'עוד'], 'mobile dock labels changed');
    same(slots.slice(0, 3).map(slot => slot.href),
      ['login.html', 'schedule-management.html?tab=mine', 'attendance.html'],
      'direct dock destinations changed');
    same(slots.map(slot => slot.aria), ['בית', 'סידור עבודה', 'דיווח שעות', 'התחנה', 'עוד'],
      'direct dock accessible names changed');
    if (!await mobilePage.locator('#resqDock').isVisible()) throw new Error('dock is hidden');
    const bodyPadding = await mobilePage.locator('body').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom));
    if (bodyPadding < 81) throw new Error('content is not protected from dock: ' + bodyPadding);
    const edges = await mobilePage.locator('#resqDock > *').evaluateAll(nodes => ({
      left:Math.min(...nodes.map(node => node.getBoundingClientRect().left)),
      right:Math.max(...nodes.map(node => node.getBoundingClientRect().right))
    }));
    if (edges.left < 43 || edges.right > 347) throw new Error('landscape safe edges: ' + JSON.stringify(edges));
  });
  /* ======================================================================
   *  „סט A" — אייקון צבעוני מעל טקסט, בכל רוחב
   * ====================================================================== */
  await test('every dock slot carries its own icon with the label underneath', async () => {
    const slots = await mobilePage.locator('#resqDock > *').evaluateAll(nodes => nodes.map(node => {
      const icon = node.querySelector('svg.dockIco');
      const label = node.querySelector('.dockLbl');
      return {
        label: label ? label.textContent : null,
        paths: icon ? icon.querySelectorAll('path').length : 0,
        hidden: icon ? icon.getAttribute('aria-hidden') : null,
        stroke: icon ? icon.getAttribute('stroke') : null,
        aria: node.getAttribute('aria-label'),
        active: node.classList.contains('on'),
        // האייקון מעל הטקסט, לא לידו — נבדק בגאומטריה ולא במחלקה.
        below: icon && label
          ? label.getBoundingClientRect().top >= icon.getBoundingClientRect().bottom - 1 : false,
        colour: getComputedStyle(icon).color
      };
    }));
    same(slots.map(slot => slot.label), ['בית', 'סידור', 'שעות', 'התחנה', 'עוד'],
      'dock labels changed');
    if (slots.some(slot => slot.paths < 1)) throw new Error('a dock slot has no icon: ' + JSON.stringify(slots));
    if (slots.some(slot => slot.hidden !== 'true')) throw new Error('the decorative icon is exposed to screen readers');
    if (slots.some(slot => slot.stroke !== 'currentColor')) throw new Error('an icon is not drawn in currentColor');
    if (slots.some(slot => !slot.below)) throw new Error('a label is not under its icon: ' + JSON.stringify(slots));
    slots.forEach((slot, index) => {
      const expected = ['בית', 'סידור עבודה', 'דיווח שעות', 'התחנה', 'עוד'][index];
      if (slot.aria !== expected) throw new Error('accessible name ' + slot.aria + ' != ' + expected);
    });
    /* ⭐ כל אייקון לא-פעיל נושא את צבע האזור שלו — לא אפור אחיד, ולא
     * חמישה שמות למשתנה אחד. הצבע נמשך מהטוקן עצמו ומושווה לחישוב
     * בפועל, כדי שטוקן שלא הוגדר יפיל את הבדיקה במקום ליפול בשקט
     * חזרה לצבע ברירת המחדל. */
    const expected = await mobilePage.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const probe = document.createElement('span');
      document.body.appendChild(probe);
      const resolve = (value) => { probe.style.color = value; return getComputedStyle(probe).color; };
      const out = {};
      for (const id of ['home', 'schedule', 'hours', 'station', 'more']) {
        const token = style.getPropertyValue('--dock-' + id).trim();
        out[id] = token ? resolve(token) : null;
      }
      probe.style.color = 'var(--accent-txt)';
      out.accent = getComputedStyle(probe).color;
      probe.remove();
      return out;
    });
    if (['home', 'schedule', 'hours', 'station', 'more'].some(id => !expected[id])) {
      throw new Error('a dock colour token is undefined: ' + JSON.stringify(expected));
    }
    const areaColours = new Set(['home', 'schedule', 'hours', 'station', 'more'].map(id => expected[id]));
    if (areaColours.size !== 5) throw new Error('the five area colours are not distinct: ' + JSON.stringify(expected));
    ['home', 'schedule', 'hours', 'station', 'more'].forEach((id, index) => {
      const slot = slots[index];
      const want = slot.active ? expected.accent : expected[id];
      if (slot.colour !== want) {
        throw new Error('slot ' + slot.label + ' icon is ' + slot.colour + ', expected ' + want);
      }
    });
  });

  await test('the active slot is ResQ orange on soft orange, and drops its area colour', async () => {
    const active = await mobilePage.locator('#resqDock .on').evaluateAll(nodes => nodes.map(node => ({
      label: node.querySelector('.dockLbl')?.textContent,
      background: getComputedStyle(node).backgroundColor,
      text: getComputedStyle(node).color,
      icon: getComputedStyle(node.querySelector('svg.dockIco')).color
    })));
    if (active.length !== 1) throw new Error('expected exactly one active slot, got ' + active.length);
    const accent = await mobilePage.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent-txt)';
      probe.style.backgroundColor = 'var(--accent-soft)';
      document.body.appendChild(probe);
      const style = getComputedStyle(probe);
      const out = { text:style.color, soft:style.backgroundColor };
      probe.remove();
      return out;
    });
    if (active[0].background !== accent.soft) throw new Error('active background is not the soft accent: ' + JSON.stringify({ active:active[0], accent }));
    if (active[0].text !== accent.text) throw new Error('active label is not the accent: ' + JSON.stringify({ active:active[0], accent }));
    // האייקון הפעיל כתום כמו הטקסט, ולא בצבע האזור שלו.
    if (active[0].icon !== accent.text) throw new Error('active icon kept its area colour: ' + JSON.stringify({ active:active[0], accent }));
  });

  await test('the dock holds its shape and touch target at 320, 360 and 390', async () => {
    const original = mobilePage.viewportSize();
    for (const width of [320, 360, 390]) {
      await mobilePage.setViewportSize({ width, height:800 });
      await mobilePage.waitForTimeout(60);
      const shape = await mobilePage.evaluate(() => {
        const slots = [...document.querySelectorAll('#resqDock > *')];
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          boxes: slots.map(node => node.getBoundingClientRect()).map(box => ({ w:box.width, h:box.height })),
          stacked: slots.every(node => {
            const icon = node.querySelector('svg.dockIco').getBoundingClientRect();
            const label = node.querySelector('.dockLbl').getBoundingClientRect();
            return label.top >= icon.bottom - 1;
          }),
          // הטקסט נשאר — לא נחתך לכלום ולא מוסתר ברוחב צר.
          labelled: slots.every(node => (node.querySelector('.dockLbl').textContent || '').trim().length > 0
            && node.querySelector('.dockLbl').getBoundingClientRect().height > 0)
        };
      });
      if (shape.overflow > 1) throw new Error('horizontal overflow at ' + width + ': ' + shape.overflow);
      if (!shape.stacked) throw new Error('labels stopped sitting under the icons at ' + width);
      if (!shape.labelled) throw new Error('a label disappeared at ' + width);
      if (shape.boxes.some(box => box.w < 43.5 || box.h < 43.5)) {
        throw new Error('touch target shrank at ' + width + ': ' + JSON.stringify(shape.boxes));
      }
    }
    if (original) await mobilePage.setViewportSize(original);
    await mobilePage.waitForTimeout(60);
  });

  await test('mobile more drawer preserves remaining personal and administrative destinations', async () => {
    await mobilePage.getByRole('button', { name:'עוד', exact:true }).click();
    const more = await mobilePage.locator('#resqDockSheet a').evaluateAll(nodes =>
      nodes.map(node => new URL(node.href).pathname.split('/').pop()));
    same(more, member.filter(href => [
      'login.html','schedule-management.html','attendance.html',
      'board.html','guards.html','sign.html','quals.html','alerts.html','people.html'
    ].indexOf(href) === -1), 'more drawer destination set changed');
    if (await mobilePage.locator('#resqDockSheet').getAttribute('aria-labelledby') !== 'resqDockTitle') {
      throw new Error('drawer has no accessible name');
    }
    const sheet = await mobilePage.locator('#resqDockSheet').boundingBox();
    if (!sheet || sheet.x < 57 || sheet.x + sheet.width > 333) {
      throw new Error('drawer leaves the landscape safe area: ' + JSON.stringify(sheet));
    }
    const drawerItems = mobilePage.locator('#resqDockSheet a,#resqDockSheet button');
    await drawerItems.last().focus();
    await mobilePage.keyboard.press('Tab');
    if (!await drawerItems.first().evaluate(el => document.activeElement === el)) {
      throw new Error('forward Tab escaped the dialog');
    }
    await mobilePage.keyboard.press('Shift+Tab');
    if (!await drawerItems.last().evaluate(el => document.activeElement === el)) {
      throw new Error('reverse Tab escaped the dialog');
    }
    await mobilePage.keyboard.press('Escape');
    if (!await mobilePage.getByRole('button', { name:'עוד', exact:true })
      .evaluate(el => document.activeElement === el)) throw new Error('dock focus was not restored');
  });
  await test('mobile opens one group at a time and Escape closes in two stages', async () => {
    await mobilePage.locator('#navToggle').click();
    const doors = mobilePage.locator('button.door');
    await doors.nth(0).click();
    if (!await mobilePage.locator('#panel-mine').isVisible()) throw new Error('first panel did not open');
    await doors.nth(1).click();
    if (await mobilePage.locator('#panel-mine').isVisible()) throw new Error('first panel stayed open');
    if (!await mobilePage.locator('#panel-station').isVisible()) throw new Error('second panel did not open');
    await mobilePage.keyboard.press('Escape');
    if (await mobilePage.locator('#panel-station').isVisible()) throw new Error('Escape did not close panel');
    if (!await doors.nth(1).evaluate(el => document.activeElement === el)) throw new Error('focus did not return to door');
    await mobilePage.keyboard.press('Escape');
    if (await mobilePage.locator('#navLinks').isVisible()) throw new Error('second Escape did not close menu');
    if (!await mobilePage.locator('#navToggle').evaluate(el => document.activeElement === el)) throw new Error('focus did not return to toggle');
  });
  await test('mobile controls meet the 44px touch target', async () => {
    await mobilePage.locator('#navToggle').click();
    await mobilePage.locator('button.door').first().click();
    const heights = await mobilePage.locator('#navToggle,button.door,.navPanel a,#themeBtn,#resqDock > *')
      .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)
        .filter(height => height > 0));
    if (!heights.length || heights.some(height => height < 43.5)) {
      throw new Error('touch target heights: ' + JSON.stringify(heights));
    }
  });
  await test('mobile has no horizontal overflow', async () => {
    const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) throw new Error('horizontal overflow ' + overflow + 'px');
  });
  await test('dark and light preferences remain functional', async () => {
    await mobilePage.evaluate(() => window.__applyTheme('dark'));
    if (await mobilePage.locator('html').getAttribute('data-theme') !== 'dark') throw new Error('dark mode failed');
    await mobilePage.evaluate(() => window.__applyTheme('light'));
    if (await mobilePage.locator('html').getAttribute('data-theme') !== 'light') throw new Error('light mode failed');
  });
  await test('claim replacement removes stale dock groups and hidden links', async () => {
    await mobilePage.evaluate(() => window.__renderNav({ role:'district_commander' }, 'login.html', 'מחוז'));
    const labels = await mobilePage.locator('#resqDock > *').allTextContents();
    same(labels, ['בית', 'עוד'], 'district dock leaked member groups');
    await mobilePage.getByRole('button', { name:'עוד', exact:true }).click();
    if (await mobilePage.locator('#resqDockSheet a').count()) throw new Error('district drawer contains unauthorized links');
    if (await mobilePage.locator('#dockThemeBtn').count() !== 1) throw new Error('theme utility is missing');
  });
  if (process.env.NAV_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.NAV_SCREENSHOT_DIR, { recursive:true });
    await mobilePage.screenshot({ path:path.join(process.env.NAV_SCREENSHOT_DIR, 'nav-mobile.png'), fullPage:true });
  }
  await mobile.close();

  const desktop = await browser.newContext({ viewport:{ width:1280, height:800 }, locale:'he-IL' });
  const desktopPage = await open(desktop, { role:'commander' }, 'attendance.html');
  await test('desktop shows three groups and marks the current group', async () => {
    if (await desktopPage.locator('#navToggle').isVisible()) throw new Error('mobile toggle is visible');
    if (await desktopPage.locator('button.door').count() !== 3) throw new Error('expected three doors');
    const here = desktopPage.locator('button.door.here');
    if (await here.count() !== 1 || !/המשמרת שלי/.test(await here.textContent())) throw new Error('current group is not marked');
    await here.click();
    const current = desktopPage.locator('#appNav a[aria-current="page"]');
    if (await current.count() !== 1 || await current.textContent() !== 'נוכחות') throw new Error('current page link changed');
  });
  await test('desktop has no horizontal overflow', async () => {
    const overflow = await desktopPage.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) throw new Error('horizontal overflow ' + overflow + 'px');
  });
  if (process.env.NAV_SCREENSHOT_DIR) {
    await desktopPage.screenshot({ path:path.join(process.env.NAV_SCREENSHOT_DIR, 'nav-desktop.png'), fullPage:true });
  }
  await desktop.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log('');
if (failures.length) {
  console.error(failures.length + ' failed; ' + passed + ' passed');
  failures.forEach(item => console.error('- ' + item));
  process.exitCode = 1;
} else {
  console.log(passed + ' tests passed');
}
