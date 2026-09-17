import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where, orderBy, limit } from 'firebase/firestore';

const SID = 'eilat_102';
const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('loopback emulator only');
const [host, portText] = endpoint.split(':');
const env = await initializeTestEnvironment({
  projectId:'resq-callout-privacy',
  firestore:{ rules:readFileSync('../firestore.rules', 'utf8'), host, port:Number(portText) }
});
// This dedicated loopback-only test project must start empty: replacing a
// parent document does not remove responses left by a previous test run.
await env.clearFirestore();

const actor = (uid, role) => env.authenticatedContext(uid, {
  email:uid + '@example.test', emp:'9' + uid.length, role, stationId:SID, shift:'A'
}).firestore();
const commander = actor('commander_1', 'commander');
const superAdmin = env.authenticatedContext('super_1', { super:true, stationId:'other_station', role:'super_admin' }).firestore();
const fakeSuper = env.authenticatedContext('fake_super', { super:'true', stationId:'other_station', role:'super_admin' }).firestore();
const recipient = actor('recipient_1', 'firefighter');
const recipient2 = actor('recipient_2', 'firefighter');
const unrelated = actor('unrelated_1', 'firefighter');
const calloutPath = `stations/${SID}/callouts/callout_1`;

await env.withSecurityRulesDisabled(async context => {
  const db = context.firestore();
  for (const [uid, role] of [['commander_1','commander'], ['recipient_1','firefighter'], ['recipient_2','firefighter'], ['unrelated_1','firefighter']]) {
    await setDoc(doc(db, `stations/${SID}/users/${uid}`), {
      stationId:SID, role, employee_number:'9' + uid.length, is_active:true
    });
  }
  await setDoc(doc(db, calloutPath), {
    by_uid:'commander_1', by_role:'commander', by_crew:'A', crew:'A',
    text:'קריאת בדיקה', uids:['recipient_1', 'recipient_2'], active:true,
    legacy_ack_compat:true, acks:{},
    created_key:'2026-09-14T10:00:00.000Z'
  });
});

let passed = 0;
async function pass(name, promise) {
  await promise; passed += 1; console.log('✓ ' + name);
}

await pass('creator reads own callout', assertSucceeds(getDoc(doc(commander, calloutPath))));
await pass('super reads another station callout', assertSucceeds(getDoc(doc(superAdmin, calloutPath))));
await pass('super can list target station callouts', assertSucceeds(getDocs(query(collection(superAdmin, `stations/${SID}/callouts`), orderBy('created_key', 'desc'), limit(10)))));
await pass('super can inspect responses without becoming a recipient', assertSucceeds(getDocs(collection(superAdmin, `${calloutPath}/responses`))));
await pass('string super grants no access', assertFails(getDoc(doc(fakeSuper, calloutPath))));
await pass('super still cannot directly mutate callout state', assertFails(updateDoc(doc(superAdmin, calloutPath), { active:false })));
await pass('recipient reads only a callout addressed to them', assertSucceeds(getDoc(doc(recipient, calloutPath))));
await pass('unrelated station member cannot read the callout', assertFails(getDoc(doc(unrelated, calloutPath))));
await pass('unrelated station member cannot list callouts', assertFails(getDocs(collection(unrelated, `stations/${SID}/callouts`))));
await pass('creator query is constrained by by_uid', assertSucceeds(getDocs(query(
  collection(commander, `stations/${SID}/callouts`),
  where('by_uid', '==', 'commander_1'), orderBy('created_key', 'desc'), limit(10)
))));
await pass('recipient query is constrained by uids', assertSucceeds(getDocs(query(
  collection(recipient, `stations/${SID}/callouts`),
  where('uids', 'array-contains', 'recipient_1'), where('active', '==', true)
))));
await pass('cached 42H.18 recipient query remains compatible during the bridge window', assertSucceeds(getDocs(query(
  collection(recipient, `stations/${SID}/callouts`),
  where('uids', 'array-contains', 'recipient_1'), orderBy('created_key', 'desc'), limit(1)
))));
await pass('cached 42H.18 client can write only its own bounded legacy acknowledgement', assertSucceeds(updateDoc(
  doc(recipient, calloutPath), { 'acks.recipient_1':{
    resp:'coming', name:'Recipient One', at:'2026-09-14T10:01:00.000Z'
  } }
)));
await pass('legacy bridge cannot write another recipient acknowledgement', assertFails(updateDoc(
  doc(recipient, calloutPath), { 'acks.recipient_2':{
    resp:'coming', name:'Recipient Two', at:'2026-09-14T10:01:00.000Z'
  } }
)));
await pass('legacy bridge cannot change any parent field', assertFails(updateDoc(
  doc(recipient, calloutPath), { text:'טקסט שונה' }
)));
await pass('legacy bridge rejects an oversized timestamp', assertFails(updateDoc(
  doc(recipient, calloutPath), { 'acks.recipient_1':{
    resp:'coming', name:'Recipient One', at:'2'.repeat(41)
  } }
)));
await pass('legacy bridge rejects impossible timestamp fields', assertFails(updateDoc(
  doc(recipient, calloutPath), { 'acks.recipient_1':{
    resp:'coming', name:'Recipient One', at:'2026-99-99T99:99:99.999Z'
  } }
)));
await pass('legacy bridge rejects timestamp punctuation payloads', assertFails(updateDoc(
  doc(recipient, calloutPath), { 'acks.recipient_1':{
    resp:'coming', name:'Recipient One', at:'2026-09-14T+++Z'
  } }
)));
const response1 = `${calloutPath}/responses/recipient_1`;
const response2 = `${calloutPath}/responses/recipient_2`;
const seenAt = '2026-09-14T10:00:30.000Z';
await pass('recipient can mark an addressed active callout as seen without answering', assertSucceeds(setDoc(
  doc(recipient, response1), { seen_at:seenAt }
)));
await pass('seen-only response cannot contain partial answer fields', assertFails(setDoc(
  doc(recipient, response1), { seen_at:seenAt, name:'partial' }
)));
await pass('recipient cannot mark another recipient response as seen', assertFails(setDoc(
  doc(recipient, response2), { seen_at:seenAt }
)));
await pass('seen timestamp must be a strict bounded ISO value', assertFails(setDoc(
  doc(recipient, response1), { seen_at:'2026-99-99T99:99:99.999Z' }
)));
await pass('recipient can accept without a reason', assertSucceeds(setDoc(doc(recipient, response1), {
  seen_at:seenAt, resp:'coming', name:'', at:'2026-09-14T10:01:00.000Z', reason:''
})));
await pass('answer update cannot rewrite the original seen timestamp', assertFails(setDoc(doc(recipient, response1), {
  seen_at:'2026-09-14T10:01:30.000Z', resp:'coming', name:'',
  at:'2026-09-14T10:01:30.000Z', reason:''
})));
await pass('recipient cannot write another recipient response', assertFails(setDoc(doc(recipient, response2), {
  seen_at:seenAt, resp:'coming', name:'', at:'2026-09-14T10:01:00.000Z', reason:''
})));
await pass('rejection without a reason is denied', assertFails(setDoc(doc(recipient, response1), {
  seen_at:seenAt, resp:'no', name:'', at:'2026-09-14T10:01:00.000Z', reason:''
})));
await pass('whitespace-only rejection reason is denied', assertFails(setDoc(doc(recipient, response1), {
  seen_at:seenAt, resp:'no', name:'', at:'2026-09-14T10:01:00.000Z', reason:'   \t'
})));
await pass('rejection with a bounded reason is accepted', assertSucceeds(setDoc(doc(recipient, response1), {
  seen_at:seenAt, resp:'no', name:'', at:'2026-09-14T10:01:00.000Z', reason:'מחלה מאושרת'
})));
await pass('seen-only update cannot erase an existing final answer', assertFails(setDoc(
  doc(recipient, response1), { seen_at:seenAt }
)));
await pass('private response rejects an oversized timestamp', assertFails(setDoc(doc(recipient, response1), {
  seen_at:seenAt, resp:'coming', name:'', at:'2'.repeat(41), reason:''
})));
await pass('private response rejects a malformed timestamp', assertFails(setDoc(doc(recipient, response1), {
  seen_at:seenAt, resp:'coming', name:'', at:'not-a-timestamp', reason:''
})));
await pass('private response rejects impossible timestamp fields', assertFails(setDoc(doc(recipient, response1), {
  seen_at:seenAt, resp:'coming', name:'', at:'2026-99-99T99:99:99.999Z', reason:''
})));
await pass('private response rejects timestamp punctuation payloads', assertFails(setDoc(doc(recipient, response1), {
  seen_at:seenAt, resp:'coming', name:'', at:'2026-09-14T+++Z', reason:''
})));
await pass('creator can read a recipient response', assertSucceeds(getDoc(doc(commander, response1))));
await pass('creator can query all private responses for the console', assertSucceeds(getDocs(
  collection(commander, `${calloutPath}/responses`)
)));
await pass('recipient can read their own response', assertSucceeds(getDoc(doc(recipient, response1))));
await pass('another recipient cannot read a rejection reason', assertFails(getDoc(doc(recipient2, response1))));

await env.withSecurityRulesDisabled(async context => {
  await updateDoc(doc(context.firestore(), calloutPath), { active:false });
});
await pass('cached 42H.18 recipient can still read its closed parent during the bridge window',
  assertSucceeds(getDoc(doc(recipient, calloutPath))));
await pass('recipient cannot change an answer after the creator closes the callout', assertFails(setDoc(
  doc(recipient, response1), {
    seen_at:seenAt, resp:'coming', name:'', at:'2026-09-14T10:02:00.000Z', reason:''
  }
)));
await pass('recipient cannot add a late answer after the creator closes the callout', assertFails(setDoc(
  doc(recipient2, response2), {
    seen_at:seenAt, resp:'coming', name:'', at:'2026-09-14T10:02:00.000Z', reason:''
  }
)));

await env.cleanup();
console.log(`\n${passed}/${passed} callout privacy rules checks passed.`);
