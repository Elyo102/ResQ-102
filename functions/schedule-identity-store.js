'use strict';

const crypto = require('node:crypto');
const access = require('./schedule-access');
const personContract = require('./schedule-person-contract');
const storeContract = require('./schedule-identity-store-contract');
const importContract = require('./schedule-import-identity');

const GLOBAL_LINK_COLLECTION = 'schedule_person_link_reservations';
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const PERSON_ID_RE = /^sp_[a-z0-9][a-z0-9_-]{7,63}$/;

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
}

function digest(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

function createScheduleIdentityStore({ db, identity, HttpsError, serverTimestamp }) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function'
      || !identity || typeof identity.context !== 'function' || typeof identity.requireLive !== 'function'
      || typeof HttpsError !== 'function' || typeof serverTimestamp !== 'function') {
    throw new TypeError('db, identity, HttpsError and serverTimestamp are required');
  }

  const fail = (code, message) => { throw new HttpsError(code, message); };
  const stationRef = (sid) => db.collection('stations').doc(sid);
  const childRef = (sid, collection, id) => stationRef(sid).collection(collection).doc(id);
  const globalLinkRef = (uid) => db.collection(GLOBAL_LINK_COLLECTION).doc(storeContract.linkIndexDocumentId(uid));
  const dataOf = (snap) => snap && snap.exists ? snap.data() : null;

  function requestId(value) {
    const id = String(value || '').trim();
    storeContract.operationDocumentId(id);
    return id;
  }

  function exactOperation(value, expected) {
    return plain(value) && value.schema_version === 1 && value.station_id === expected.station_id
      && value.actor_uid === expected.actor_uid && value.action === expected.action
      && value.fingerprint === expected.fingerprint && plain(value.result);
  }

  function replayResult(value, intent) {
    if (!plain(value)) fail('data-loss', 'תוצאת הפעולה השמורה פגומה.');
    if (intent.action === 'link' || intent.action === 'unlink') {
      if (!exactKeys(value, ['person', 'state_revision', 'bindings_invalidated', 'replayed'])
          || value.replayed !== false || value.bindings_invalidated !== true
          || !Number.isSafeInteger(value.state_revision) || value.state_revision < 1
          || !exactKeys(value.person, ['person_id', 'station_id', 'display_name', 'active'])
          || value.person.station_id !== intent.station_id || typeof value.person.person_id !== 'string'
          || typeof value.person.display_name !== 'string' || typeof value.person.active !== 'boolean') {
        fail('data-loss', 'תוצאת הפעולה השמורה פגומה.');
      }
    } else if (intent.action === 'set-binding') {
      const binding = value.binding;
      if (!exactKeys(value, ['binding', 'state_revision', 'replayed']) || value.replayed !== false
          || !Number.isSafeInteger(value.state_revision) || value.state_revision < 1
          || !exactKeys(binding, ['binding_id', 'source_namespace', 'source_key', 'person_id',
            'expected_person_revision', 'revision'])
          || binding.source_namespace !== importContract.SOURCE_NAMESPACE
          || typeof binding.person_id !== 'string' || !PERSON_ID_RE.test(binding.person_id)
          || !Number.isSafeInteger(binding.expected_person_revision) || binding.expected_person_revision < 1
          || binding.expected_person_revision >= Number.MAX_SAFE_INTEGER
          || !Number.isSafeInteger(binding.revision) || binding.revision < 1
          || binding.revision >= Number.MAX_SAFE_INTEGER) {
        fail('data-loss', 'תוצאת הפעולה השמורה פגומה.');
      }
      const sourceKey = importContract.sourceKey(binding.source_key);
      if (stable(sourceKey) !== stable(binding.source_key)
          || storeContract.bindingDocumentId(binding.source_namespace, sourceKey) !== binding.binding_id) {
        fail('data-loss', 'תוצאת הפעולה השמורה פגומה.');
      }
    } else {
      fail('data-loss', 'סוג הפעולה השמורה אינו נתמך.');
    }
    return Object.freeze({ ...value, replayed:true });
  }

  function state(value) {
    try { return storeContract.normalizeState(value); }
    catch (_) { fail('failed-precondition', 'מצב זהויות הסידור חסר או פגום.'); }
  }

  function incrementable(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
      fail('failed-precondition', label + ' הגיע למגבלת גרסה.');
    }
    return value + 1;
  }

  function normalizeStoredBinding(value, sid, bindingId) {
    if (!exactKeys(value, ['schema_version', 'station_id', 'binding_id', 'source_namespace',
      'source_key', 'person_id', 'expected_person_revision', 'revision'])
        || value.schema_version !== 1 || value.station_id !== sid || value.binding_id !== bindingId
        || value.source_namespace !== importContract.SOURCE_NAMESPACE
        || typeof value.person_id !== 'string' || !PERSON_ID_RE.test(value.person_id)
        || !Number.isSafeInteger(value.expected_person_revision) || value.expected_person_revision < 1
        || value.expected_person_revision >= Number.MAX_SAFE_INTEGER
        || !Number.isSafeInteger(value.revision) || value.revision < 1
        || value.revision >= Number.MAX_SAFE_INTEGER) {
      fail('data-loss', 'קישור מקור שמור פגום.');
    }
    const sourceKey = importContract.sourceKey(value.source_key);
    if (stable(sourceKey) !== stable(value.source_key)
        || storeContract.bindingDocumentId(value.source_namespace, sourceKey) !== bindingId) {
      fail('data-loss', 'קישור מקור שמור פגום.');
    }
    return Object.freeze({ ...value, source_key:sourceKey });
  }

  async function requireManager(tx, ctx) {
    const live = await identity.requireLive(tx, ctx);
    if (ctx.super === true) return live;
    const ref = childRef(ctx.sid, 'schedule_access', ctx.uid);
    const snap = await tx.get(ref);
    if (!access.isManagerAccess(dataOf(snap), ctx.sid, ctx.uid)) {
      fail('permission-denied', 'מינוי אחראי/ת הסידור אינו פעיל.');
    }
    return live;
  }

  function refs(ctx, input, uid) {
    const personId = String(input.person_id || '').trim();
    const opId = storeContract.operationDocumentId(requestId(input.request_id));
    return {
      person: childRef(ctx.sid, storeContract.COLLECTIONS.people, personId),
      state: childRef(ctx.sid, storeContract.COLLECTIONS.state, storeContract.STATE_DOCUMENT),
      stationLink: uid ? childRef(ctx.sid, storeContract.COLLECTIONS.link_index,
        storeContract.linkIndexDocumentId(uid)) : null,
      globalLink: uid ? globalLinkRef(uid) : null,
      operation: childRef(ctx.sid, storeContract.COLLECTIONS.operations, opId),
      audit: childRef(ctx.sid, storeContract.COLLECTIONS.audit, 'sa_' + opId.slice(3))
    };
  }

  function operationIntent(ctx, action, input, safeInput) {
    return Object.freeze({
      station_id: ctx.sid,
      actor_uid: ctx.uid,
      action,
      fingerprint: digest({ action, station_id: ctx.sid, actor_uid: ctx.uid, input: safeInput }),
      request_id: requestId(input.request_id)
    });
  }

  function replayOrFail(value, intent) {
    if (!value) return null;
    if (!exactOperation(value, intent)) fail('already-exists', 'מזהה הבקשה כבר שימש לפעולה אחרת.');
    return replayResult(value.result, intent);
  }

  async function link(req) {
    const ctx = identity.context(req);
    const input = plain(req && req.data) ? req.data : {};
    const uid = String(input.uid || '').trim();
    if (!personContract.validUid(uid)) fail('invalid-argument', 'מזהה החשבון אינו תקין.');
    const expectedPersonRevision = input.expected_person_revision;
    const expectedStateRevision = input.expected_state_revision;
    const intent = operationIntent(ctx, 'link', input, {
      person_id:String(input.person_id || '').trim(), uid,
      expected_person_revision:expectedPersonRevision, expected_state_revision:expectedStateRevision
    });
    const r = refs(ctx, input, uid);
    const userRef = childRef(ctx.sid, 'users', uid);

    return db.runTransaction(async (tx) => {
      await requireManager(tx, ctx);
      const [personSnap, stateSnap, userSnap, stationLinkSnap, globalLinkSnap, operationSnap] = await Promise.all([
        tx.get(r.person), tx.get(r.state), tx.get(userRef), tx.get(r.stationLink), tx.get(r.globalLink), tx.get(r.operation)
      ]);
      const replay = replayOrFail(dataOf(operationSnap), intent);
      if (replay) return replay;
      const current = personContract.normalizeSchedulePerson(dataOf(personSnap));
      const currentState = state(dataOf(stateSnap));
      const user = dataOf(userSnap);
      if (current.station_id !== ctx.sid || current.kind !== 'external' || current.linked_uid !== null || current.active !== true) {
        fail('failed-precondition', 'האדם אינו זמין לקישור.');
      }
      if (current.revision !== expectedPersonRevision || currentState.revision !== expectedStateRevision) {
        fail('aborted', 'הנתונים השתנו; יש לרענן ולנסות שוב.');
      }
      if (!access.activeMember(user, ctx.sid)) fail('failed-precondition', 'החשבון אינו פעיל בתחנה הזאת.');
      if (dataOf(stationLinkSnap) || dataOf(globalLinkSnap)) fail('already-exists', 'החשבון כבר מקושר לאדם בסידור.');
      const personRevision = incrementable(current.revision, 'גרסת האדם');
      const stateRevision = incrementable(currentState.revision, 'גרסת המצב');
      const after = personContract.normalizeSchedulePerson({ ...current, kind:'registered', linked_uid:uid, revision:personRevision });
      const reservation = Object.freeze({ schema_version:1, station_id:ctx.sid, person_id:current.person_id, revision:1 });
      const result = Object.freeze({ person:storeContract.publicPerson(after), state_revision:stateRevision,
        bindings_invalidated:true, replayed:false });
      const common = { schema_version:1, station_id:ctx.sid, actor_uid:ctx.uid, action:'link',
        person_id:current.person_id, created_at:serverTimestamp() };
      tx.set(r.person, after);
      tx.create(r.stationLink, reservation);
      tx.create(r.globalLink, reservation);
      tx.set(r.state, { ...currentState, revision:stateRevision });
      tx.create(r.audit, common);
      tx.create(r.operation, { ...intent, schema_version:1, result, created_at:serverTimestamp() });
      return result;
    });
  }

  async function unlink(req) {
    const ctx = identity.context(req);
    const input = plain(req && req.data) ? req.data : {};
    const expectedPersonRevision = input.expected_person_revision;
    const expectedStateRevision = input.expected_state_revision;
    const expectedLinkRevision = input.expected_link_revision;
    const personId = String(input.person_id || '').trim();
    const intent = operationIntent(ctx, 'unlink', input, {
      person_id:personId, expected_person_revision:expectedPersonRevision,
      expected_state_revision:expectedStateRevision, expected_link_revision:expectedLinkRevision
    });
    const initialPersonRef = childRef(ctx.sid, storeContract.COLLECTIONS.people, personId);
    const initialOperationRef = childRef(ctx.sid, storeContract.COLLECTIONS.operations,
      storeContract.operationDocumentId(intent.request_id));

    return db.runTransaction(async (tx) => {
      await requireManager(tx, ctx);
      const [personSnap, operationSnap] = await Promise.all([tx.get(initialPersonRef), tx.get(initialOperationRef)]);
      const replay = replayOrFail(dataOf(operationSnap), intent);
      if (replay) return replay;
      const current = personContract.normalizeSchedulePerson(dataOf(personSnap));
      if (current.station_id !== ctx.sid || current.kind !== 'registered' || !current.linked_uid) {
        fail('failed-precondition', 'האדם אינו מקושר.');
      }
      const r = refs(ctx, input, current.linked_uid);
      const [stateSnap, stationLinkSnap, globalLinkSnap] = await Promise.all([
        tx.get(r.state), tx.get(r.stationLink), tx.get(r.globalLink)
      ]);
      const currentState = state(dataOf(stateSnap));
      const stationLink = dataOf(stationLinkSnap);
      const globalLink = dataOf(globalLinkSnap);
      if (current.revision !== expectedPersonRevision || currentState.revision !== expectedStateRevision) {
        fail('aborted', 'הנתונים השתנו; יש לרענן ולנסות שוב.');
      }
      const exact = (value) => plain(value) && value.schema_version === 1 && value.station_id === ctx.sid
        && value.person_id === current.person_id && value.revision === expectedLinkRevision;
      if (!exact(stationLink) || !exact(globalLink)) fail('aborted', 'קישור החשבון השתנה או אינו עקבי.');
      const personRevision = incrementable(current.revision, 'גרסת האדם');
      const stateRevision = incrementable(currentState.revision, 'גרסת המצב');
      incrementable(expectedLinkRevision, 'גרסת הקישור');
      const after = personContract.normalizeSchedulePerson({ ...current, kind:'external', linked_uid:null, revision:personRevision });
      const result = Object.freeze({ person:storeContract.publicPerson(after), state_revision:stateRevision,
        bindings_invalidated:true, replayed:false });
      tx.set(r.person, after);
      tx.delete(r.stationLink);
      tx.delete(r.globalLink);
      tx.set(r.state, { ...currentState, revision:stateRevision });
      tx.create(r.audit, { schema_version:1, station_id:ctx.sid, actor_uid:ctx.uid, action:'unlink',
        person_id:current.person_id, created_at:serverTimestamp() });
      tx.create(r.operation, { ...intent, schema_version:1, result, created_at:serverTimestamp() });
      return result;
    });
  }

  async function setSourceBinding(req) {
    const ctx = identity.context(req);
    const input = plain(req && req.data) ? req.data : {};
    if (input.source_namespace !== importContract.SOURCE_NAMESPACE) {
      fail('invalid-argument', 'מרחב מקור הסידור אינו מאושר.');
    }
    const sourceKey = importContract.sourceKey(input.source_key);
    const bindingId = storeContract.bindingDocumentId(input.source_namespace, sourceKey);
    const personId = String(input.person_id || '').trim();
    const expectedPersonRevision = input.expected_person_revision;
    const expectedStateRevision = input.expected_state_revision;
    const expectedBindingRevision = input.expected_binding_revision === null ? null : input.expected_binding_revision;
    if (expectedBindingRevision !== null && (!Number.isSafeInteger(expectedBindingRevision) || expectedBindingRevision < 1)) {
      fail('invalid-argument', 'גרסת קישור המקור אינה תקינה.');
    }
    const intent = operationIntent(ctx, 'set-binding', input, { source_namespace:input.source_namespace,
      source_key:sourceKey, person_id:personId, expected_person_revision:expectedPersonRevision,
      expected_state_revision:expectedStateRevision, expected_binding_revision:expectedBindingRevision });
    const operation = childRef(ctx.sid, storeContract.COLLECTIONS.operations,
      storeContract.operationDocumentId(intent.request_id));
    const audit = childRef(ctx.sid, storeContract.COLLECTIONS.audit,
      'sa_' + storeContract.operationDocumentId(intent.request_id).slice(3));
    const personRef = childRef(ctx.sid, storeContract.COLLECTIONS.people, personId);
    const stateRef = childRef(ctx.sid, storeContract.COLLECTIONS.state, storeContract.STATE_DOCUMENT);
    const bindingRef = childRef(ctx.sid, storeContract.COLLECTIONS.bindings, bindingId);
    return db.runTransaction(async (tx) => {
      await requireManager(tx, ctx);
      const [personSnap, stateSnap, bindingSnap, operationSnap] = await Promise.all([
        tx.get(personRef), tx.get(stateRef), tx.get(bindingRef), tx.get(operation)
      ]);
      const replay = replayOrFail(dataOf(operationSnap), intent);
      if (replay) return replay;
      const person = personContract.normalizeSchedulePerson(dataOf(personSnap));
      const currentState = state(dataOf(stateSnap));
      const previous = dataOf(bindingSnap);
      const priorBinding = previous === null ? null : normalizeStoredBinding(previous, ctx.sid, bindingId);
      if (person.station_id !== ctx.sid || person.active !== true || person.revision !== expectedPersonRevision
          || currentState.revision !== expectedStateRevision) {
        fail('aborted', 'האדם או מצב הזהויות השתנו; יש לרענן.');
      }
      if ((expectedBindingRevision === null && priorBinding !== null)
          || (expectedBindingRevision !== null && (!priorBinding
            || priorBinding.revision !== expectedBindingRevision))) {
        fail('aborted', 'קישור המקור השתנה; יש לרענן.');
      }
      const bindingRevision = expectedBindingRevision === null ? 1
        : incrementable(expectedBindingRevision, 'גרסת קישור המקור');
      const stateRevision = incrementable(currentState.revision, 'גרסת המצב');
      const binding = Object.freeze({ schema_version:1, station_id:ctx.sid, binding_id:bindingId,
        source_namespace:importContract.SOURCE_NAMESPACE, source_key:sourceKey, person_id:person.person_id,
        expected_person_revision:person.revision, revision:bindingRevision });
      const publicBinding = Object.freeze({ binding_id:bindingId, source_namespace:binding.source_namespace,
        source_key:binding.source_key, person_id:binding.person_id,
        expected_person_revision:binding.expected_person_revision, revision:binding.revision });
      const result = Object.freeze({ binding:publicBinding, state_revision:stateRevision, replayed:false });
      tx.set(bindingRef, binding);
      tx.set(stateRef, { ...currentState, revision:stateRevision });
      tx.create(audit, { schema_version:1, station_id:ctx.sid, actor_uid:ctx.uid, action:'set-binding',
        person_id:person.person_id, binding_id:bindingId, created_at:serverTimestamp() });
      tx.create(operation, { ...intent, schema_version:1, result, created_at:serverTimestamp() });
      return result;
    });
  }

  function encodeCursor(sid, personId) {
    return Buffer.from(JSON.stringify({ v:1, sid, person_id:personId }), 'utf8').toString('base64url');
  }

  function decodeCursor(value, sid) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      fail('invalid-argument', 'סמן העמוד אינו תקין.');
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
    catch (_) { fail('invalid-argument', 'סמן העמוד אינו תקין.'); }
    if (!plain(parsed) || Object.keys(parsed).sort().join('|') !== 'person_id|sid|v'
        || parsed.v !== 1 || parsed.sid !== sid || typeof parsed.person_id !== 'string'
        || !/^sp_[a-z0-9][a-z0-9_-]{7,63}$/.test(parsed.person_id)) {
      fail('invalid-argument', 'סמן העמוד אינו שייך לתחנה הזאת.');
    }
    return parsed.person_id;
  }

  async function listPeople(req) {
    const ctx = identity.context(req);
    const input = plain(req && req.data) ? req.data : {};
    const limit = input.limit === undefined ? PAGE_SIZE : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      fail('invalid-argument', 'גודל העמוד אינו תקין.');
    }
    const cursor = decodeCursor(input.cursor, ctx.sid);
    return db.runTransaction(async (tx) => {
      await requireManager(tx, ctx);
      let query = stationRef(ctx.sid).collection(storeContract.COLLECTIONS.people).orderBy('person_id').limit(limit + 1);
      if (cursor) query = query.startAfter(cursor);
      const snap = await tx.get(query);
      const rows = snap.docs.map((doc) => storeContract.publicPerson(doc.data()));
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return Object.freeze({ people:Object.freeze(page),
        next_cursor:hasMore ? encodeCursor(ctx.sid, page[page.length - 1].person_id) : null });
    });
  }

  async function listBindings(req) {
    const ctx = identity.context(req);
    const input = plain(req && req.data) ? req.data : {};
    const limit = input.limit === undefined ? PAGE_SIZE : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      fail('invalid-argument', 'גודל העמוד אינו תקין.');
    }
    const cursor = decodeBindingCursor(input.cursor, ctx.sid);
    return db.runTransaction(async (tx) => {
      await requireManager(tx, ctx);
      let query = stationRef(ctx.sid).collection(storeContract.COLLECTIONS.bindings).orderBy('binding_id').limit(limit + 1);
      if (cursor) query = query.startAfter(cursor);
      const snap = await tx.get(query);
      const rows = snap.docs.map((doc) => {
        const value = normalizeStoredBinding(doc.data(), ctx.sid, doc.id);
        return Object.freeze({ binding_id:value.binding_id, source_namespace:value.source_namespace,
          source_key:value.source_key, person_id:value.person_id,
          expected_person_revision:value.expected_person_revision, revision:value.revision });
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return Object.freeze({ bindings:Object.freeze(page),
        next_cursor:hasMore ? encodeBindingCursor(ctx.sid, page[page.length - 1].binding_id) : null });
    });
  }

  function encodeBindingCursor(sid, bindingId) {
    return Buffer.from(JSON.stringify({ v:1, sid, binding_id:bindingId }), 'utf8').toString('base64url');
  }

  function decodeBindingCursor(value, sid) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      fail('invalid-argument', 'סמן קישורי המקור אינו תקין.');
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
    catch (_) { fail('invalid-argument', 'סמן קישורי המקור אינו תקין.'); }
    if (!exactKeys(parsed, ['v', 'sid', 'binding_id']) || parsed.v !== 1 || parsed.sid !== sid
        || typeof parsed.binding_id !== 'string' || !/^sb_[a-f0-9]{48}$/.test(parsed.binding_id)) {
      fail('invalid-argument', 'סמן קישורי המקור אינו שייך לתחנה הזאת.');
    }
    return parsed.binding_id;
  }

  return Object.freeze({ link, unlink, setSourceBinding, listPeople, listBindings });
}

module.exports = Object.freeze({ createScheduleIdentityStore, GLOBAL_LINK_COLLECTION, PAGE_SIZE, MAX_PAGE_SIZE });
