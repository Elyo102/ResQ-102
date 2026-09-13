import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'alerts.html'), 'utf8');
const index = fs.readFileSync(path.join(root, 'functions', 'index.js'), 'utf8');
const schedule = fs.readFileSync(path.join(root, 'functions', 'schedule-runtime.js'), 'utf8');

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
assert.match(index, /signedClaims\.personal_lab_control !== true/);
assert.match(index, /claims\.personal_lab_control !== true/);
assert.match(index, /activation_auth_time_ms: authMs/);
assert.match(index, /schema: 'personal-live-lab-v2'/);
assert.match(index, /admin\.messaging\(\)\.send\(\{\s*token:\s*payload\.token/);
assert.match(index, /Number\(q\.count \|\| 0\) >= 3/);
assert.match(index, /Number\(q\.last_at_ms \|\| 0\) \+ 60000/);
assert.match(index, /Number\(before\.generation\)[\s\S]*?Number\(before\.generation\) \+ 1 : 1/);
assert.match(schedule, /delivery_policy === 'trial_control'[\s\S]*?activeTrialControl/);
assert.match(schedule, /claims\.personal_lab_control === true/);
assert.match(schedule, /activation_auth_time_ms/);
assert.match(schedule, /getAuthUser\(String\(candidateValue\.person \|\| ''\)\)/);
assert.match(schedule, /validateOutboxForSend\(ref, claimed\.lease_token, claimed\)/);

console.log('personal-live-lab wiring: passed');
