import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'alerts.html'), 'utf8');
const index = fs.readFileSync(path.join(root, 'functions', 'index.js'), 'utf8');

assert.match(html, /id="labCard"/);
assert.match(html, /id="btnLabPush" disabled/);
assert.match(html, /httpsCallable\(fns, 'sendPersonalLiveLabPush'\)/);
assert.match(html, /if \(!confirm\('לשלוח הודעת בדיקה ניטרלית למכשיר הזה בלבד\?'\)\) return/);
assert.match(html, /acknowledgeLab\(d\.probe_id, 'foreground'\)/);
assert.match(html, /acknowledgeLab\(new URL\(location\.href\).*'opened'/s);

const start = html.indexOf('// ---------- מעבדת המכשיר האישית');
const end = html.indexOf('// ---------- טעינה', start);
assert.doesNotMatch(html.slice(start, end), /sendBroadcast|sendCallout|setSilentMode/);

assert.match(index, /const PERSONAL_LAB_OPTIONS[\s\S]*?enforceAppCheck:\s*true/);
assert.match(index, /admin\.auth\(\)\.getUser\(signed\.uid\)/);
assert.match(index, /admin\.messaging\(\)\.send\(\{\s*token:\s*payload\.token/);
assert.match(index, /Number\(q\.count \|\| 0\) >= 3/);
assert.match(index, /Number\(q\.last_at_ms \|\| 0\) \+ 60000/);

console.log('personal-live-lab wiring: passed');
