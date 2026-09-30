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
// The fourth argument records provider entry. Trial delivery must fence again
// after fresh Auth validation; accepting an optional argument would miss that.
const deliveryStart = schedule.indexOf('  async function deliverOutbox(ref) {');
const deliveryEnd = schedule.indexOf('  async function resumeOutbox()', deliveryStart);
assert.ok(deliveryStart >= 0 && deliveryEnd > deliveryStart, 'bounded delivery source exists');
const deliverySource = schedule.slice(deliveryStart, deliveryEnd);
function assertDeliveryFences(source) {
  const ordered = [
    /await beforeOutboxSend\(claimed\);/,
    /if \(!await validateOutboxForSend\(ref, claimed\.lease_token, claimed,\s*claimed\.delivery_policy !== 'trial_control'\)\) return \{ skipped: true \};/,
    /if \(claimed\.delivery_policy === 'trial_control'\) \{/,
    /currentAuth = await getAuthUser\(String\(claimed\.person \|\| ''\)\);/,
    /if \(!trialAuthValid\(currentAuth, String\(claimed\.person \|\| ''\),\s*String\(claimed\.station_id \|\| ''\), Number\(claimed\.control_auth_time_ms\)\)\) \{/,
    /await cancelLeasedOutbox\(ref, claimed\.lease_token, 'trial-control-inactive'\);\s*return \{ skipped: true \};/,
    /if \(!await validateOutboxForSend\(ref, claimed\.lease_token, claimed, true\)\) return \{ skipped: true \};/,
    /providerEntered\s*=\s*true;/,
    /const delivery = await sendPush\(claimed\.station_id, claimed\.person, 'schedule_mine',/
  ];
  let offset = 0;
  for (const [index, pattern] of ordered.entries()) {
    const match = pattern.exec(source.slice(offset));
    assert.ok(match, 'delivery fence/order contract step ' + index);
    offset += match.index + match[0].length;
  }
}
assertDeliveryFences(deliverySource);
const finalFence = "if (!await validateOutboxForSend(ref, claimed.lease_token, claimed, true)) return { skipped: true };";
const mutations = [
  ['missing final fence', value => value.replace(finalFence, '')],
  ['disabled provider entry', value => value.replace(finalFence, finalFence.replace(', true)', ', false)'))],
  ['missing provider entry argument', value => value.replace(finalFence, finalFence.replace(', true)', ')'))],
  ['changed lease', value => value.replace(finalFence, finalFence.replace('claimed.lease_token', 'otherLease'))],
  ['changed claim', value => value.replace(finalFence, finalFence.replace(', claimed,', ', otherClaim,'))],
  ['ordinary policy bypass', value => value.replace("claimed.delivery_policy !== 'trial_control'", 'true')],
  ['premature final fence', value => value.replace(finalFence, '').replace('await beforeOutboxSend(claimed);', finalFence + '\nawait beforeOutboxSend(claimed);')]
];
for (const [name, mutate] of mutations) {
  const changed = mutate(deliverySource);
  assert.notEqual(changed, deliverySource, name + ' mutation applied');
  assert.throws(() => assertDeliveryFences(changed), /delivery fence\/order contract/, name);
}
console.log('personal-live-lab delivery fence mutations: ' + mutations.length + ' rejected');

console.log('personal-live-lab wiring: passed');
