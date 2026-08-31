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

const serviceWorker = read('firebase-messaging-sw.js');
const pwaRuntime = read('pwa.js');
const visibleVersion = read('version.js').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
const visibleDate = read('version.js').match(/APP_DATE\s*=\s*'([^']+)'/)?.[1];
const serverVersion = JSON.parse(read('version.json'));
const versionKey = String(visibleVersion || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const loginPage = read('login.html');
check(visibleVersion === serverVersion.v && visibleDate === serverVersion.d,
      'visible and server release versions stay synchronized');
check(loginPage.includes("./version.js?v=" + versionKey),
      'login imports the release-specific version module');
check(serviceWorker.includes("const CACHE = 'resq-v" + versionKey + "-release1'"),
      'service worker cache belongs to the visible release');
check(serviceWorker.includes("String(k).startsWith('resq-') && k !== CACHE"),
      'service worker activation preserves non-ResQ caches');
check(pwaRuntime.includes("updateViaCache: 'none'"),
      'service worker update bypasses the browser HTTP cache');
check(loginPage.includes("refreshInstalledApp({ version: server.v })") &&
      pwaRuntime.includes("RESQ_SKIP_WAITING") &&
      pwaRuntime.includes("searchParams.set('updated'"),
      'update action activates the waiting worker and reloads with a fresh URL');
check(pwaRuntime.includes("startsWith('resq-')") && pwaRuntime.includes("key !== keep"),
      'update cleanup preserves the new and non-ResQ caches');
check(/caches\.match\(req\s*,\s*\{\s*ignoreSearch\s*:\s*true\s*\}\s*\)/.test(serviceWorker),
      'service worker offline fallback ignores asset version query strings');
for (const asset of ['./bulletin.js', './bulletin.css']) {
  check(serviceWorker.includes(asset), 'service worker shell includes ' + asset);
}

const systemCheck = read('check.html');
const subStationProbe = systemCheck.indexOf("if (col.name === 'sub_stations')");
const genericProbe = systemCheck.indexOf("const id = MARK + '_' + Date.now();");
check(systemCheck.includes("const SUB_STATION_PROBE_ID = '__selfcheck_archived_site'"),
      'deployment check reuses one archived sub-station probe');
check(subStationProbe !== -1 && genericProbe !== -1 && subStationProbe < genericProbe,
      'archived sub-station probe bypasses the generic create-delete path');
for (const token of ["is_active: false", "archived: true", "status: 'archived'",
                     'const saved = await getDoc(ref)', 'continue;']) {
  check(systemCheck.slice(subStationProbe, genericProbe).includes(token),
        'archived sub-station probe contains ' + token);
}

const bulletin = read('bulletin.js');
const board = read('board.html');
const attendanceBoard = read('attendance.html');
const stations = read('stations.js');
for (const item of [
  ['bulletin.js', bulletin, 'subStationAvailable(data)'],
  ['board.html', board, 'subStationAvailable(v)'],
  ['attendance.html', attendanceBoard, 'subStationAvailable(v)']
]) {
  check(item[1].includes(item[2]), item[0] + ' uses the shared active sub-station contract');
}
for (const token of ['data.is_active !== false', 'data.active !== false',
                     'data.archived !== true', "state !== 'inactive'", "state !== 'archived'"]) {
  check(stations.includes(token), 'shared sub-station contract contains ' + token);
}

const login = read('login.html');
for (const id of ['loginEmp','loginPass','fName','fEmail','fPhone','fDistrict','fStation','fShift','fPass','fPass2','pwOld','pwNew','pwNew2']) {
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

await import('./pwa-update.mjs');
if (bad) process.exit(1);
console.log('Shared UX foundation is consistent across ' + pages.length + ' HTML screens.');
