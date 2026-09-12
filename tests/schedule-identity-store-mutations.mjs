import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const functionsDir = path.resolve(here, '..', 'functions');
const sourcePath = path.join(functionsDir, 'schedule-identity-store.js');
const testPath = path.join(functionsDir, 'schedule-identity-store.test.js');
const temporary = path.join(functionsDir, '.schedule-identity-store.mutation.js');
const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');

const mutations = [
  ['global reservation ignored',
    'if (dataOf(stationLinkSnap) || dataOf(globalLinkSnap))',
    'if (dataOf(stationLinkSnap))', 1,
    (body) => body.replace('tx.create(r.globalLink, reservation);', 'tx.set(r.globalLink, reservation);')],
  ['manager grant ignored',
    'if (!access.isManagerAccess(dataOf(snap), ctx.sid, ctx.uid))',
    'if (false && !access.isManagerAccess(dataOf(snap), ctx.sid, ctx.uid))'],
  ['person CAS ignored',
    'if (current.revision !== expectedPersonRevision || currentState.revision !== expectedStateRevision)',
    'if (false || currentState.revision !== expectedStateRevision)', 2],
  ['state CAS ignored',
    'if (current.revision !== expectedPersonRevision || currentState.revision !== expectedStateRevision)',
    'if (current.revision !== expectedPersonRevision || false)', 2],
  ['replay fingerprint ignored',
    '&& value.fingerprint === expected.fingerprint && plain(value.result);',
    '&& plain(value.result);'],
  ['cross-station cursor accepted',
    '|| parsed.v !== 1 || parsed.sid !== sid || typeof parsed.person_id !== \'string\'',
    '|| parsed.v !== 1 || false || typeof parsed.person_id !== \'string\''],
  ['raw uid leaked to global reservation',
    "const reservation = Object.freeze({ schema_version:1, station_id:ctx.sid, person_id:current.person_id, revision:1 });",
    "const reservation = Object.freeze({ schema_version:1, station_id:ctx.sid, person_id:current.person_id, revision:1, uid });"],
  ['unlink skips global consistency',
    'if (!exact(stationLink) || !exact(globalLink))',
    'if (!exact(stationLink) || false)'],
  ['corrupt replay projection accepted',
    "if (!exactKeys(value, ['person', 'state_revision', 'bindings_invalidated', 'replayed'])",
    "if (!plain(value)", 1,
    (body) => body.replace("|| !exactKeys(value.person, ['person_id', 'station_id', 'display_name', 'active'])",
      '|| !plain(value.person)')],
  ['binding namespace accepted',
    'if (input.source_namespace !== importContract.SOURCE_NAMESPACE)',
    'if (false)'],
  ['binding person CAS ignored',
    'if (person.station_id !== ctx.sid || person.active !== true || person.revision !== expectedPersonRevision',
    'if (person.station_id !== ctx.sid || person.active !== true || false'],
  ['binding state CAS ignored',
    "if (person.station_id !== ctx.sid || person.active !== true || person.revision !== expectedPersonRevision\n          || currentState.revision !== expectedStateRevision) {",
    "if (person.station_id !== ctx.sid || person.active !== true || person.revision !== expectedPersonRevision\n          || false) {"]
];

try {
  for (const [name, needle, replacement, expectedOccurrences = 1, after = (body) => body] of mutations) {
    const occurrences = source.split(needle).length - 1;
    assert.equal(occurrences, expectedOccurrences, `${name}: mutation anchor count`);
    fs.writeFileSync(temporary, after(source.replace(needle, replacement)), 'utf8');
    const result = spawnSync(process.execPath, [testPath], {
      cwd:functionsDir,
      env:{ ...process.env, SCHEDULE_IDENTITY_STORE_SUBJECT:temporary },
      encoding:'utf8'
    });
    assert.notEqual(result.status, 0, `${name}: broken implementation survived\n${result.stdout}\n${result.stderr}`);
    console.log('✓ ' + name);
  }
  console.log(`${mutations.length}/${mutations.length} schedule identity store mutations caught.`);
} finally {
  try { fs.unlinkSync(temporary); } catch (_) {}
}
