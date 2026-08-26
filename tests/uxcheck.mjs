import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let bad = 0;
const check = (value, message) => {
  if (value) console.log('✓ ' + message);
  else { bad++; console.error('✗ ' + message); }
};

const pages = fs.readdirSync(root).filter(file => file.endsWith('.html'));
for (const file of pages) {
  const html = read(file);
  check(/name=["']viewport["']/.test(html), file + ' has a viewport');
  check(/<html[^>]+(?:dir=["']rtl["'][^>]+lang=["']he["']|lang=["']he["'][^>]+dir=["']rtl["'])/.test(html), file + ' declares Hebrew RTL');
}

const theme = read('theme.css');
for (const token of ['--touch-min:44px', '.ui-card', '.ui-btn', '.ui-control', '.ui-message', '.ui-skeleton']) {
  check(theme.includes(token), 'shared UI contains ' + token);
}
const nav = read('nav.js');
for (const token of ["aria-label', 'ניווט ראשי", "aria-current', 'page", "event.key !== 'Escape'", 'min-height:44px']) {
  check(nav.includes(token), 'navigation contains ' + token);
}

const login = read('login.html');
for (const id of ['loginEmp','loginPass','fName','fEmail','fPhone','fDistrict','fStation','fShift','fCode','fPass','fPass2','pwOld','pwNew','pwNew2']) {
  check(new RegExp('<label[^>]+for=["\\\']' + id + '["\\\']').test(login), 'login label is associated with ' + id);
}
for (const token of ['role="tablist"', 'role="tab"', 'role="tabpanel"', 'aria-live="polite"', 'role="alert"']) {
  check(login.includes(token), 'login accessibility contains ' + token);
}
for (const token of ['tabindex="-1"', "event.key === 'ArrowRight'", "event.key === 'ArrowLeft'", "event.key === 'Home'", "event.key === 'End'"]) {
  check(login.includes(token), 'login tabs contain ' + token);
}
for (const token of ['body.art{ background:#070d18', 'body.art h1{ color:#f4f7fb', 'body.art input, body.art select', 'color:#f8fafc']) {
  check(login.includes(token), 'login artwork keeps explicit dark-surface contrast: ' + token);
}

const schedule = read('schedule.html');
for (const token of ['<main id="mainView"', '<h1 class="screen-title">', 'aria-label="החודש הקודם"', 'aria-label="החודש הבא"', 'role="list"', "setAttribute('role', 'listitem')", "createElement('button')", 'min-width:44px;min-height:44px']) {
  check(schedule.includes(token), 'schedule accessibility contains ' + token);
}
for (const id of ['ovKind','ovDate','ovCrew','ovNote']) {
  check(new RegExp('<label[^>]+for=["\\\']' + id + '["\\\']').test(schedule), 'schedule label is associated with ' + id);
}

const attendance = read('attendance.html');
for (const token of ['<main class="wrap">', 'aria-label="החודש הקודם"',
  'aria-label="החודש הבא"', 'role="dialog"', 'aria-modal="true"',
  'aria-hidden="true"', 'function openOv()', 'ovReturnFocus',
  "e.key !== 'Tab'", 'function focusAfterRender(key)',
  'b.dataset.date = key', '<caption class="sr-only">']) {
  check(attendance.includes(token), 'attendance UX contains ' + token);
}
for (const id of ['pickWho','dType','dShape','dStart','dEnd','dStart2','dEnd2',
                  'dOtReason','dSite','dNotes']) {
  check(new RegExp('<label[^>]+for=["\\\']' + id + '["\\\']').test(attendance),
        'attendance label is associated with ' + id);
}

const swaps = read('swaps.html');
for (const token of ['<main class="wrap">', 'role="dialog"', 'aria-modal="true"',
  'aria-hidden="true"', 'function openOv(', 'ovReturnFocus',
  "e.key !== 'Tab'", "style.removeProperty('display')",
  "createElement('button')", "setAttribute('aria-pressed'",
  'function focusStatus(', 'closeOv(false)']) {
  check(swaps.includes(token), 'swaps UX contains ' + token);
}
for (const id of ['myDate','hisDate','wantCrew','newNote','pq','tkDate','rr']) {
  check(new RegExp('<label[^>]+for=["\\\']' + id + '["\\\']').test(swaps),
        'swaps label is associated with ' + id);
}
check(!swaps.includes("$('ov').style.display"),
      'swaps dialogs do not leave an inline display override');

const forms = read('forms.html');
for (const token of ['<main class="wrap">', 'role="tablist"', 'role="tab"',
  'role="tabpanel"', 'aria-selected="true"', 'aria-controls="viewNew"',
  'function activateView(', 'function visibleViews(', "event.key === 'ArrowRight'",
  "event.key === 'Home'", 'lab.htmlFor = fieldId', "b.type = 'button'"]) {
  check(forms.includes(token), 'forms UX contains ' + token);
}
for (const id of ['fPick','awayDate']) {
  check(new RegExp('<label[^>]+for=["\\\']' + id + '["\\\']').test(forms),
        'forms label is associated with ' + id);
}

const sign = read('sign.html');
for (const token of ['<main class="wrap">', 'role="tablist"', 'role="tab"',
  'role="tabpanel"', 'aria-selected="true"', 'aria-controls="viewQueue"',
  'function activateSignView(', 'function ensurePad(', 'function setupPadControls(',
  'if (PAD) return PAD', 'if (rect.width <= 0 || rect.height <= 0) return null',
  "event.key === 'ArrowRight'", "event.key === 'Home'", "$('fileSig').click()",
  "requestAnimationFrame(function () { ensurePad(); })", "el.setAttribute('role', 'listitem')"]) {
  check(sign.includes(token), 'sign UX contains ' + token);
}
check(/<button[^>]+id=["']btnUpload["']/.test(sign),
      'sign image upload uses a keyboard-accessible button');
check(/<label[^>]+for=["']why["'] \+ i/.test(sign),
      'sign on-behalf reason receives an associated label');
check(!sign.includes('setupPad();'),
      'sign canvas is not initialized while its panel is hidden');

if (bad) process.exit(1);
console.log('Shared UX foundation is consistent across ' + pages.length + ' HTML screens.');
