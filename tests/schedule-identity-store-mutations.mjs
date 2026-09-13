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
    'global_link:dataOf(globalLinkSnap)',
    'global_link:null', 1,
    (body) => body.replace('tx.create(r.globalLink, reservation);', 'tx.set(r.globalLink, reservation);')],
  ['manager grant ignored',
    'if (!access.isManagerAccess(dataOf(snap), ctx.sid, ctx.uid))',
    'if (false && !access.isManagerAccess(dataOf(snap), ctx.sid, ctx.uid))'],
  ['link target auth ignored',
    'await requireLinkTarget(ctx, uid);',
    '', 2,
    (body) => body.split('await requireLinkTarget(ctx, uid);').join('')],
  ['final link target auth fence ignored',
    "      // Firebase Auth and Firestore are separate systems. Recheck the live Auth\n"
      + "      // account immediately before the irreversible reservations are written.\n"
      + '      await requireLinkTarget(ctx, uid);',
    '      // final target fence removed'],
  ['live Auth target verification ignored',
    'await requireLinkTarget(ctx, uid);',
    'await Promise.resolve();', 2],
  ['person CAS ignored',
    'if (current.revision !== expectedPersonRevision || currentState.revision !== expectedStateRevision)',
    'if (false || currentState.revision !== expectedStateRevision)'],
  ['state CAS ignored',
    'if (current.revision !== expectedPersonRevision || currentState.revision !== expectedStateRevision)',
    'if (current.revision !== expectedPersonRevision || false)'],
  ['replay fingerprint ignored',
    '&& value.fingerprint === expected.fingerprint && plain(value.result);',
    '&& plain(value.result);'],
  ['cross-station cursor accepted',
    '|| parsed.v !== 1 || parsed.sid !== sid || typeof parsed.person_id !== \'string\'',
    '|| parsed.v !== 1 || false || typeof parsed.person_id !== \'string\''],
  ['raw uid leaked to global reservation',
    'tx.create(r.globalLink, reservation);',
    'tx.create(r.globalLink, { ...reservation, uid });'],
  ['link loses immutable source provenance',
    'const after = planned.after;',
    'const after = { ...planned.after, source_ref:null };'],
  ['management response leaks raw uid',
    'person:storeContract.managementPerson(after)',
    'person:{ ...storeContract.managementPerson(after), linked_uid:uid }'],
  ['corrupt replay projection accepted',
    "if (!exactKeys(value, ['person', 'state', 'bindings_invalidated', 'replayed'])",
    "if (!plain(value)", 1,
    (body) => body.replace("|| !exactKeys(value.person, ['person_id', 'station_id', 'display_name', 'active',\n            'kind', 'linked', 'revision'])",
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
