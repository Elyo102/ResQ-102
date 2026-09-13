'use strict';

const { createHash } = require('node:crypto');
const { createOpsMemberIdentity } = require('./ops-member-identity');

const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const SIGNATURE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_VALUES_BYTES = 16 * 1024;
const LIMITS = Object.freeze({ text:300, phone:300, long:4000 });
const FORMS = Object.freeze({
  leave:Object.freeze({
    he:'בקשת חופשה', kind:'vacation', private:false,
    fields:Object.freeze([
      ['from','date',true], ['to','date',true],
      ['where','pick',true,Object.freeze(['באילת','בארץ','בחו״ל'])],
      ['phone','phone',false], ['why','long',false]
    ])
  }),
  noclock:Object.freeze({
    he:'דוח אי החתמת כרטיס', kind:'missed_punch', private:false,
    fields:Object.freeze([
      ['date','date',true], ['in','time',true], ['out','time',true], ['why','long',true]
    ])
  }),
  injury:Object.freeze({
    he:'דוח פציעה', kind:'form', private:true,
    fields:Object.freeze([
      ['date','date',true], ['time','time',true], ['where','text',true],
      ['what','long',true], ['hurt','text',true], ['med','yesno',true]
    ])
  }),
  damage_rep:Object.freeze({
    he:'דוח נזק', kind:'form', private:false,
    fields:Object.freeze([
      ['date','date',true], ['where','text',true], ['what','long',true],
      ['who','long',false], ['how','long',true]
    ])
  })
});

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function validSignatureImage(value) {
  if (typeof value !== 'string' || value.length < 100 || value.length > 400000
    || !SIGNATURE.test(value)) return false;
  const comma = value.indexOf(',');
  const encoded = value.slice(comma + 1);
  let bytes;
  try { bytes = Buffer.from(encoded, 'base64'); } catch (ignore) { return false; }
  if (!bytes.length || bytes.toString('base64') !== encoded) return false;
  return value.startsWith('data:image/png;') ? validPng(bytes) : validJpeg(bytes);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(bytes) {
  if (bytes.length < 57
    || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false;
  let offset = 8, index = 0, sawIdat = false, sawIend = false;
  while (offset + 12 <= bytes.length && !sawIend) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const dataEnd = offset + 8 + length;
    const expected = bytes.readUInt32BE(dataEnd);
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== expected) return false;
    if (index === 0 && (type !== 'IHDR' || length !== 13
      || bytes.readUInt32BE(offset + 8) === 0 || bytes.readUInt32BE(offset + 12) === 0)) return false;
    if (index > 0 && type === 'IHDR') return false;
    if (type === 'IDAT') sawIdat = true;
    if (type === 'IEND') {
      if (length !== 0 || !sawIdat) return false;
      sawIend = true;
    }
    offset = dataEnd + 4; index += 1;
  }
  return sawIend && offset === bytes.length;
}

function validJpeg(bytes) {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
  let offset = 2, sawFrame = false, sawScan = false;
  const frames = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  while (offset < bytes.length - 2 && !sawScan) {
    if (bytes[offset++] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9
      || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) return false;
    if (frames.has(marker)) {
      if (length < 8 || bytes.readUInt16BE(offset + 3) === 0
        || bytes.readUInt16BE(offset + 5) === 0) return false;
      sawFrame = true;
    }
    if (marker === 0xda) {
      if (length < 6 || !sawFrame || offset + length >= bytes.length - 2) return false;
      sawScan = true;
    }
    offset += length;
  }
  return sawFrame && sawScan;
}

function createFormSubmissions({
  db, auth, HttpsError, serverTimestamp, clock = Date.now, hooks = {}
} = {}) {
  if (!db || typeof db.runTransaction !== 'function' || !auth
    || typeof auth.getUser !== 'function' || typeof HttpsError !== 'function'
    || typeof serverTimestamp !== 'function') {
    throw new TypeError('db, auth, HttpsError and serverTimestamp required');
  }
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const error = (code, message) => new HttpsError(code, message);
  const station = sid => db.collection('stations').doc(sid);
  const submissionRef = (sid, id) => station(sid).collection('submissions').doc(id);
  const operationRef = (sid, id) => station(sid).collection('form_submission_operations').doc(id);

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
      throw error('internal', 'שעון השרת אינו זמין.');
    }
    return value;
  }
  function date(value) {
    if (typeof value !== 'string' || !DAY.test(value)) throw error('invalid-argument', 'תאריך אינו תקין.');
    const parsed = new Date(value + 'T00:00:00.000Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw error('invalid-argument', 'תאריך אינו תקין.');
    }
    return value;
  }
  function cleanValue(value, type, required, options) {
    if (typeof value !== 'string') throw error('invalid-argument', 'ערך בטופס אינו תקין.');
    const out = value.trim().normalize('NFC');
    if (required && !out) throw error('invalid-argument', 'חסר שדה חובה.');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(out)) {
      throw error('invalid-argument', 'הטופס מכיל תווים שאינם נתמכים.');
    }
    if (!out) return '';
    if (type === 'date') return date(out);
    if (type === 'time' && !TIME.test(out)) throw error('invalid-argument', 'שעה אינה תקינה.');
    if (type === 'pick' && !options.includes(out)) throw error('invalid-argument', 'בחירה אינה תקינה.');
    if (type === 'yesno' && !['כן','לא'].includes(out)) throw error('invalid-argument', 'בחירה אינה תקינה.');
    const max = LIMITS[type];
    if (max && out.length > max) throw error('invalid-argument', 'ערך בטופס ארוך מדי.');
    return out;
  }
  function normalizeValues(form, values) {
    if (!plain(values)) throw error('invalid-argument', 'ערכי הטופס אינם תקינים.');
    const keys = form.fields.map(field => field[0]);
    if (Object.keys(values).some(key => !keys.includes(key))) {
      throw error('invalid-argument', 'הטופס מכיל שדות שאינם מותרים.');
    }
    const result = {};
    for (const [key, type, required, options] of form.fields) {
      result[key] = cleanValue(own(values, key) ? values[key] : '', type, required, options || []);
    }
    if (form.kind === 'vacation') {
      if (result.to < result.from) throw error('invalid-argument', 'טווח החופשה אינו תקין.');
      const from = new Date(result.from + 'T00:00:00.000Z');
      const to = new Date(result.to + 'T00:00:00.000Z');
      if (Math.floor((to - from) / 86400000) + 1 > 400) {
        throw error('invalid-argument', 'טווח החופשה ארוך מדי.');
      }
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_VALUES_BYTES) {
      throw error('invalid-argument', 'הטופס גדול מדי.');
    }
    return Object.freeze(result);
  }
  function request(req, statusOnly) {
    const ctx = identity.context(req);
    const data = req.data;
    const allowed = statusOnly ? ['request_id'] : ['request_id','form_id','values','signature_image'];
    if (!plain(data) || Object.keys(data).some(key => !allowed.includes(key))) {
      throw error('invalid-argument', 'שדות הבקשה אינם תקינים.');
    }
    if (typeof data.request_id !== 'string' || !REQUEST_ID.test(data.request_id)) {
      throw error('invalid-argument', 'מזהה הבקשה אינו תקין.');
    }
    const authTime = req.auth && req.auth.token && req.auth.token.auth_time;
    if (!Number.isSafeInteger(authTime) || authTime < 0 || !Number.isSafeInteger(authTime * 1000)) {
      throw error('unauthenticated', 'יש לרענן את ההתחברות.');
    }
    if (statusOnly) return { ctx, data, authTime };
    const form = FORMS[data.form_id];
    if (!form) throw error('invalid-argument', 'הטופס אינו מוכר.');
    if (!validSignatureImage(data.signature_image)) {
      throw error('invalid-argument', 'החתימה אינה תקינה.');
    }
    const values = normalizeValues(form, data.values);
    return { ctx, data, authTime, form, values };
  }
  async function live(tx, state) {
    let user;
    try {
      user = await auth.getUser(state.ctx.uid);
    } catch (cause) {
      if (cause && cause.code === 'auth/user-not-found') {
        throw error('permission-denied', 'החשבון אינו זמין.');
      }
      throw error('unavailable', 'לא ניתן לאמת את החשבון כרגע.');
    }
    const claims = user && user.customClaims;
    if (!user || user.uid !== state.ctx.uid || user.disabled === true || !plain(claims)
      || claims.stationId !== state.ctx.sid || (claims.super === true) !== state.ctx.super
      || (!state.ctx.super && claims.role !== state.ctx.role)) {
      throw error('permission-denied', 'השיוך או התפקיד השתנו.');
    }
    if (user.tokensValidAfterTime !== undefined) {
      const validAfter = Date.parse(user.tokensValidAfterTime);
      if (!Number.isFinite(validAfter)) throw error('unavailable', 'אימות החשבון אינו זמין.');
      if (state.authTime * 1000 < validAfter) throw error('permission-denied', 'ההתחברות בוטלה.');
    }
    return identity.requireLive(tx, state.ctx);
  }
  function ids(state) {
    return {
      submissionId:hash(['form-submission-v1', state.ctx.sid, state.ctx.uid, state.data.request_id]),
      operationId:hash(['form-submission-operation-v1', state.ctx.sid, state.ctx.uid, state.data.request_id])
    };
  }
  function validReceipt(snapshot, state, id) {
    if (!snapshot.exists) return null;
    const value = snapshot.data();
    if (!plain(value) || value.schema !== 'form-submission-operation-v1'
      || value.station_id !== state.ctx.sid || value.actor_uid !== state.ctx.uid
      || value.request_id !== state.data.request_id || value.submission_id !== id
      || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) {
      throw error('failed-precondition', 'קבלת ההגשה אינה תקינה.');
    }
    return value;
  }
  async function submit(req) {
    const state = request(req, false);
    const { submissionId, operationId } = ids(state);
    const fingerprint = hash([
      'form-submission-payload-v1', state.ctx.sid, state.ctx.uid,
      state.data.form_id, state.values, state.data.signature_image
    ]);
    const target = submissionRef(state.ctx.sid, submissionId);
    const receipt = operationRef(state.ctx.sid, operationId);
    return db.runTransaction(async tx => {
      const actor = await live(tx, state);
      const [priorSnap, targetSnap] = await Promise.all([tx.get(receipt), tx.get(target)]);
      const prior = validReceipt(priorSnap, state, submissionId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw error('already-exists', 'מזהה הבקשה כבר שימש לתוכן אחר.');
        }
        if (!targetSnap.exists || !plain(targetSnap.data())
          || targetSnap.data().request_fingerprint !== fingerprint) {
          throw error('failed-precondition', 'ההגשה הקודמת אינה שלמה.');
        }
        await live(tx, state);
        return Object.freeze({ committed:true, duplicate:true, submission_id:submissionId });
      }
      if (targetSnap.exists) throw error('failed-precondition', 'קיימת הגשה ללא קבלה תואמת.');
      if (typeof hooks.beforeWrites === 'function') await hooks.beforeWrites({ stage:'submit' });
      const fresh = await live(tx, state);
      const at = now();
      const iso = new Date(at).toISOString();
      const employee = Object.freeze({
        image:state.data.signature_image, uid:fresh.uid, name:fresh.full_name,
        emp:fresh.employee_number, role:fresh.role, at:iso
      });
      const document = {
        form_id:state.data.form_id, form_he:state.form.he, kind:state.form.kind,
        values:state.values, signature:state.data.signature_image,
        signatures:{ employee }, is_private:state.form.private, status:'submitted',
        by_uid:fresh.uid, by_name:fresh.full_name,
        by_emp:fresh.employee_number, crew:fresh.crew,
        created_key:iso, created_at:serverTimestamp(),
        request_id:state.data.request_id, request_fingerprint:fingerprint
      };
      tx.create(target, document);
      tx.create(receipt, {
        schema:'form-submission-operation-v1', station_id:state.ctx.sid,
        actor_uid:state.ctx.uid, request_id:state.data.request_id,
        submission_id:submissionId, fingerprint, status:'committed', committed_at_ms:at
      });
      return Object.freeze({ committed:true, duplicate:false, submission_id:submissionId });
    });
  }
  async function status(req) {
    const state = request(req, true);
    const { submissionId, operationId } = ids(state);
    return db.runTransaction(async tx => {
      await live(tx, state);
      const [receiptSnap, targetSnap] = await Promise.all([
        tx.get(operationRef(state.ctx.sid, operationId)),
        tx.get(submissionRef(state.ctx.sid, submissionId))
      ]);
      if (!receiptSnap.exists && !targetSnap.exists) return Object.freeze({ status:'unobserved' });
      const receipt = validReceipt(receiptSnap, state, submissionId);
      if (!receipt || !targetSnap.exists || !plain(targetSnap.data())
        || targetSnap.data().request_fingerprint !== receipt.fingerprint) {
        throw error('failed-precondition', 'מצב ההגשה אינו עקבי.');
      }
      await live(tx, state);
      return Object.freeze({ status:'committed', submission_id:submissionId });
    });
  }
  return Object.freeze({ submit, status });
}

module.exports = Object.freeze({
  createFormSubmissions, FORMS, MAX_VALUES_BYTES
});
