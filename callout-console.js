import { collection, query, where, orderBy, limit, onSnapshot, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { CREW_HE } from './rotation.js?v=42h25';
import { errorText, logError } from './error-text.js?v=42h25';
import { isTrial, TRIAL_BROADCAST_WARNING } from './mode-bar.js?v=42h25';

const ALLOWED_ROLES = Object.freeze(['commander', 'deputy']);
const ROSTER_LOAD_TIMEOUT_MS = 7000;
let active = null;

function text(value, max) {
  return String(value == null ? '' : value).normalize('NFC').trim().slice(0, max);
}

function validStation(value) {
  return /^[a-z0-9_-]{2,80}$/.test(String(value || ''));
}

function validCrew(value) {
  return ['A', 'B', 'C'].includes(String(value || ''));
}

function setMessage(element, value, kind) {
  element.textContent = value || '';
  element.className = 'msg ' + (value ? (kind || '') : '');
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(label || 'timeout');
      error.code = 'deadline-exceeded';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function rosterLoadTimeoutMs() {
  const override = Number(globalThis.__CALLOUT_RECIPIENT_TIMEOUT_MS);
  return Number.isFinite(override) && override >= 10 ? override : ROSTER_LOAD_TIMEOUT_MS;
}

function rosterName(session, uid) {
  const person = session.roster.get(uid);
  return person && person.name ? person.name : 'לא בסגל';
}

function rosterRows(session) {
  return Array.from(session.roster, ([uid, person]) => ({ uid, ...person }))
    .filter(person => session.isSuper || person.crew === session.crew)
    .filter(person => session.isSuper ? person.crew === session.crew : true)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'he'));
}

function selectedUids(session) {
  if (!session.selectedRecipients) return null;
  return Array.from(session.selectedRecipients).filter(uid => uid === session.uid || session.roster.has(uid));
}

function syncRecipientMode(session, picked) {
  const selfOnly = Array.isArray(picked) && picked.length === 1 && picked[0] === session.uid;
  if (session.elements.recipientAll) {
    session.elements.recipientAll.setAttribute('aria-pressed', session.selectedRecipients ? 'false' : 'true');
  }
  if (session.elements.recipientNone) {
    session.elements.recipientNone.setAttribute('aria-pressed',
      session.selectedRecipients && !selfOnly ? 'true' : 'false');
  }
  if (session.elements.recipientSelf) {
    session.elements.recipientSelf.setAttribute('aria-pressed', selfOnly ? 'true' : 'false');
  }
}

function selectionLabel(session, uids) {
  if (!Array.isArray(uids)) return CREW_HE[session.crew] || ('משמרת ' + session.crew);
  if (uids.length === 1 && uids[0] === session.uid) return 'בדיקת עצמי';
  return 'נבחרו ' + uids.length + ' לוחמים';
}

function renderRecipients(session) {
  const list = session.elements.recipientList;
  if (!list || active !== session) return;
  const rows = rosterRows(session);
  list.replaceChildren();
  if (!session.rosterLoaded) {
    const notice = document.createElement('div');
    notice.className = 'recipient-empty';
    notice.textContent = 'טוען רשימת לוחמים לבחירה פרטנית…';
    list.appendChild(notice);
  } else if (session.rosterFailed) {
    const notice = document.createElement('div');
    notice.className = 'recipient-empty';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'secondary';
    retry.textContent = 'טען רשימה שוב';
    retry.onclick = () => reloadRoster(session);
    notice.append('רשימת הלוחמים לא נטענה. אפשר לשלוח לכל המשמרת או לבצע בדיקת עצמי. ', retry);
    list.appendChild(notice);
  } else if (!rows.length) {
    const notice = document.createElement('div');
    notice.className = 'recipient-empty';
    notice.textContent = 'לא נמצאו לוחמים פעילים במשמרת זו. אפשר לשלוח לכל המשמרת או לבצע בדיקת עצמי במצב אימון.';
    list.appendChild(notice);
  }
  rows.forEach(person => {
    const label = document.createElement('label');
    label.className = 'recipient-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = person.uid;
    input.checked = !session.selectedRecipients || session.selectedRecipients.has(person.uid);
    label.classList.toggle('is-picked', input.checked);
    input.onchange = () => {
      if (!session.selectedRecipients) {
        session.selectedRecipients = new Set(rows.map(row => row.uid));
      }
      if (input.checked) session.selectedRecipients.add(person.uid);
      else session.selectedRecipients.delete(person.uid);
      renderRecipients(session);
    };
    const name = document.createElement('span');
    name.textContent = person.name || person.uid;
    const meta = document.createElement('small');
    meta.textContent = person.uid === session.uid ? 'אני' : (CREW_HE[person.crew] || person.crew || '');
    label.append(input, name, meta);
    list.appendChild(label);
  });
  const picked = selectedUids(session);
  syncRecipientMode(session, picked);
  if (session.elements.recipientSummary) {
    session.elements.recipientSummary.textContent = picked
      ? (picked.length
        ? 'בחירה פרטנית פעילה: הקריאה תישלח ל־' + selectionLabel(session, picked) + '.'
        : 'בחירה פרטנית פעילה: לא נבחרו נמענים.')
      : (session.rosterLoaded
        ? 'ברירת מחדל: כל אנשי ' + (CREW_HE[session.crew] || ('משמרת ' + session.crew)) + '. אפשר לבחור לוחמים ספציפיים מהרשימה.'
        : 'טוען רשימת לוחמים לבחירה פרטנית…');
  }
}

function renderLive(session, list) {
  if (active !== session) return;
  const box = session.elements.live;
  session.elements.liveCard.classList.toggle('hide', list.length === 0);
  box.replaceChildren();

  list.forEach(({ id, value }) => {
    const uids = Array.isArray(value.uids) ? value.uids : [];
    const legacy = value.acks && typeof value.acks === 'object' ? value.acks : {};
    const modern = value.responses && typeof value.responses === 'object' ? value.responses : {};
    const acks = { ...legacy, ...modern };
    const coming = [], unavailable = [], seenOnly = [];
    Object.keys(acks).forEach(uid => {
      const answer = acks[uid] || {};
      if (answer.resp === 'coming') {
        coming.push(rosterName(session, uid));
      } else if (answer.resp === 'no') {
        unavailable.push({ name:rosterName(session, uid), reason:text(answer.reason, 200) });
      } else if (answer.seen_at) {
        seenOnly.push(rosterName(session, uid));
      }
    });
    const answered = new Set(Object.keys(acks).filter(uid => {
      const answer = acks[uid] || {};
      return answer.resp === 'coming' || answer.resp === 'no' || Boolean(answer.seen_at);
    }));
    const pendingNames = uids.filter(uid => !answered.has(uid)).map(uid => rosterName(session, uid));

    const card = document.createElement('article');
    card.className = 'callout-row';
    const heading = document.createElement('strong');
    heading.textContent = (value.target_he || ('משמרת ' + session.crew)) +
      (value.active === false ? ' · סגורה' : '');
    const body = document.createElement('p');
    body.textContent = text(value.text, 300);
    const tally = document.createElement('div');
    tally.className = 'tally';
    tally.textContent = 'טרם הוצג ' + pendingNames.length + ' · הוצג, טרם ענה ' + seenOnly.length +
      ' · אישר הגעה ' + coming.length + ' · דחה ' + unavailable.length;
    card.append(heading, body, tally);

    if (coming.length) {
      const row = document.createElement('small');
      row.textContent = 'אישרו הגעה: ' + coming.join(', ');
      card.appendChild(row);
    }
    if (seenOnly.length) {
      const row = document.createElement('small');
      row.textContent = 'הוצג, טרם ענו: ' + seenOnly.join(', ');
      card.appendChild(row);
    }
    if (pendingNames.length) {
      const row = document.createElement('small');
      row.textContent = 'טרם הוצג: ' + pendingNames.join(', ');
      card.appendChild(row);
    }
    if (unavailable.length) {
      const row = document.createElement('small');
      row.textContent = 'דחו הגעה: ' + unavailable.map(item =>
        item.name + (item.reason ? ' — ' + item.reason : '')).join(', ');
      card.appendChild(row);
    }
    if (value.active !== false) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'secondary';
      close.textContent = 'סגור קריאה';
      close.onclick = async () => {
        if (active !== session || !window.confirm('לסגור את הקריאה?')) return;
        close.disabled = true;
        try {
          await session.closeCallout({ id, ...(session.isSuper ? { target_station_id:session.sid } : {}) });
        } catch (error) {
          close.disabled = false;
          setMessage(session.elements.message,
            (logError('callout close', error), 'סגירת הקריאה נכשלה. ' + errorText(error)), 'err');
        }
      };
      card.appendChild(close);
    }
    box.appendChild(card);
  });
}

function applyRosterRows(session, rows) {
  session.roster.clear();
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const uid = text(row && row.uid, 128);
    const crew = text(row && row.crew, 1);
    if (!uid || crew !== session.crew) return;
    session.roster.set(uid, { name:text(row && row.name, 120), crew });
  });
}

async function loadRosterFromServer(session) {
  const payload = { crew:session.crew, ...(session.isSuper ? { target_station_id:session.sid } : {}) };
  const response = await withTimeout(session.listCalloutRecipients(payload),
    rosterLoadTimeoutMs(), 'callout-recipients-timeout');
  const data = response && response.data ? response.data : {};
  applyRosterRows(session, data.recipients);
}

async function loadRosterFromFirestore(session) {
  // Fallback only. The authoritative picker path is the callable above; this
  // keeps older deployments usable while functions and hosting roll forward.
  const snap = await withTimeout(getDocs(collection(session.db, 'stations', session.sid, 'roster')),
    rosterLoadTimeoutMs(), 'callout-roster-timeout');
  const rows = [];
  snap.forEach(doc => {
    const value = doc.data() || {};
    rows.push({ uid:doc.id, name:value.full_name, crew:value.crew, is_active:value.is_active });
  });
  applyRosterRows(session, rows.filter(row => row.is_active !== false));
}

async function loadRoster(session) {
  // This function is reached only after initCalloutConsole has accepted the
  // signed claims. A denied role never starts a recipient read.
  try {
    await loadRosterFromServer(session);
  } catch (primary) {
    logError('callout recipients', primary);
    await loadRosterFromFirestore(session);
  }
  if (active !== session) return;
  session.rosterFailed = false;
  session.rosterLoaded = true;
  renderRecipients(session);
}

async function reloadRoster(session) {
  if (active !== session) return;
  session.rosterFailed = false;
  session.rosterLoaded = false;
  renderRecipients(session);
  try {
    await loadRoster(session);
  } catch (error) {
    if (active !== session) return;
    session.rosterFailed = true;
    session.rosterLoaded = true;
    renderRecipients(session);
    setMessage(session.elements.message,
      'רשימת השמות לא נטענה כרגע. אפשר לשלוח לכל המשמרת או לבצע בדיקת עצמי. ' + errorText(error), 'err');
  }
}

function watchOwnCallouts(session) {
  const source = query(collection(session.db, 'stations', session.sid, 'callouts'),
    ...(session.isSuper ? [] : [where('by_uid', '==', session.uid)]), orderBy('created_key', 'desc'), limit(10));
  return onSnapshot(source, snap => {
    if (active !== session) return;
    const rows = [];
    const currentIds = new Set();
    snap.forEach(doc => {
      currentIds.add(doc.id);
      const value = doc.data() || {};
      session.callouts.set(doc.id, value);
      rows.push({ id:doc.id, value:{ ...value, responses:session.responses.get(doc.id) || {} } });
      watchResponses(session, doc.id);
      if (value.by_uid === session.uid &&
          (value.target === 'crew:' + session.crew || value.target === 'people') &&
          !session.pendingRequest && value.active !== false &&
          ['reserved','delivering','partial'].includes(String(value.delivery_state || '')) &&
          /^[A-Za-z0-9_-]{16,80}$/.test(String(value.request_id || '')) && text(value.text, 300)) {
        session.pendingRequest = {
          id:String(value.request_id), message:text(value.text, 300), retries:0,
          uids:value.target === 'people' && Array.isArray(value.uids) ? value.uids.slice() : null
        };
        session.elements.input.value = session.pendingRequest.message;
        session.elements.input.readOnly = true;
        if (!session.resumeStarted && typeof session.resumeDelivery === 'function') {
          session.resumeStarted = true;
          setTimeout(() => session.resumeDelivery(), 0);
        }
      }
    });
    session.responseStops.forEach((stop, id) => {
      if (currentIds.has(id)) return;
      try { stop(); } catch (_) {}
      session.responseStops.delete(id);
      session.responses.delete(id);
      session.callouts.delete(id);
    });
    renderLive(session, rows);
  }, error => {
    if (active === session) {
      setMessage(session.elements.message,
        'מעקב התגובות אינו זמין כרגע. ' + errorText(error), 'err');
    }
  });
}

function watchResponses(session, calloutId) {
  if (session.responseStops.has(calloutId)) return;
  const source = collection(session.db, 'stations', session.sid, 'callouts', calloutId, 'responses');
  const stop = onSnapshot(source, snap => {
    if (active !== session) return;
    const answers = {};
    snap.forEach(row => { answers[row.id] = row.data() || {}; });
    session.responses.set(calloutId, answers);
    const rows = Array.from(session.callouts, ([id, value]) => ({
      id, value:{ ...value, responses:session.responses.get(id) || {} }
    }));
    renderLive(session, rows);
  }, error => {
    if (active === session) setMessage(session.elements.message,
      'תגובות הקריאה אינן זמינות כרגע. ' + errorText(error), 'err');
  });
  session.responseStops.set(calloutId, stop);
}

export function destroyCalloutConsole() {
  const prior = active;
  active = null;
  if (!prior) return;
  try { prior.stop(); } catch (_) {}
  prior.elements.send.onclick = null;
  prior.elements.live.replaceChildren();
}

export async function initCalloutConsole(options = {}) {
  destroyCalloutConsole();
  const claims = options.claims && typeof options.claims === 'object' ? options.claims : {};
  const role = String(claims.role || '');
  const isSuper = claims.super === true;
  const sid = String(isSuper ? (options.targetStationId || '') : (claims.stationId || ''));
  const crew = String(isSuper ? (options.targetCrew || '') : (claims.shift || ''));
  if (options.readOnly === true || options.rolePreview === true ||
      (!isSuper && !ALLOWED_ROLES.includes(role)) || !validStation(sid) || !validCrew(crew)) {
    throw new Error('callout-console-permission-denied');
  }
  if (!options.user || !options.user.uid || !options.db || !options.functions ||
      !options.sdk || typeof options.sdk.httpsCallable !== 'function' || !options.elements) {
    throw new Error('callout-console-invalid-options');
  }

  const session = {
    db:options.db, sid, crew, role, isSuper, uid:String(options.user.uid), elements:options.elements,
    roster:new Map(), callouts:new Map(), responses:new Map(), responseStops:new Map(), stop:() => {},
    selectedRecipients:null, rosterLoaded:false, rosterFailed:false, pendingRequest:null, retryTimer:null, resumeStarted:false, resumeDelivery:null,
    sendCallout:options.sdk.httpsCallable(options.functions, 'sendCallout'),
    listCalloutRecipients:options.sdk.httpsCallable(options.functions, 'listCalloutRecipients'),
    closeCallout:options.sdk.httpsCallable(options.functions, 'closeCallout')
  };
  active = session;
  session.elements.crew.textContent = CREW_HE[crew] || ('משמרת ' + crew);
  if (session.elements.recipientAll) session.elements.recipientAll.onclick = () => {
    if (session.pendingRequest) {
      setMessage(session.elements.message, 'שליחה קודמת ממתינה; אי אפשר לשנות נמענים עד שתסתיים.', 'info');
      return;
    }
    session.selectedRecipients = null;
    renderRecipients(session);
  };
  if (session.elements.recipientNone) session.elements.recipientNone.onclick = () => {
    if (session.pendingRequest) {
      setMessage(session.elements.message, 'שליחה קודמת ממתינה; אי אפשר לשנות נמענים עד שתסתיים.', 'info');
      return;
    }
    session.selectedRecipients = new Set();
    renderRecipients(session);
  };
  if (session.elements.recipientSelf) session.elements.recipientSelf.onclick = () => {
    if (session.pendingRequest) {
      setMessage(session.elements.message, 'שליחה קודמת ממתינה; אי אפשר לשנות נמענים עד שתסתיים.', 'info');
      return;
    }
    session.selectedRecipients = new Set([session.uid]);
    renderRecipients(session);
    setMessage(session.elements.message,
      isTrial()
        ? 'בדיקת עצמי מוכנה. שלח קריאה כדי לשמוע את צליל קריאת הפתע במכשיר הזה.'
        : 'בדיקת עצמי מיועדת למצב אימון. במצב חי המזעיק אינו מקבל קריאה לעצמו.', 'info');
  };
  const sendPending = async autoRetry => {
    if (active !== session) return;
    const typedMessage = text(session.elements.input.value, 300);
    const message = autoRetry && session.pendingRequest
      ? session.pendingRequest.message : typedMessage;
    if (!message) {
      setMessage(session.elements.message, 'צריך לכתוב את הודעת הקריאה.', 'err');
      return;
    }
    const currentUids = autoRetry && session.pendingRequest
      ? (Array.isArray(session.pendingRequest.uids) ? session.pendingRequest.uids.slice() : null)
      : selectedUids(session);
    if (Array.isArray(currentUids) && currentUids.length === 0) {
      setMessage(session.elements.message, 'יש לבחור לפחות נמען אחד לקריאת פתע.', 'err');
      return;
    }
    const targetName = selectionLabel(session, currentUids);
    if (!autoRetry && !window.confirm('להזעיק את ' + targetName + ' בתחנה ' + sid + '?\n\n' + message)) return;
    const priorUids = session.pendingRequest && Array.isArray(session.pendingRequest.uids)
      ? session.pendingRequest.uids.slice().sort().join('\0') : null;
    const nextUids = Array.isArray(currentUids) ? currentUids.slice().sort().join('\0') : null;
    if (session.pendingRequest && (session.pendingRequest.message !== message || priorUids !== nextUids)) {
      session.elements.input.value = session.pendingRequest.message;
      setMessage(session.elements.message,
        'קריאה קודמת עדיין ממתינה למסירה; ממשיכים אותה לפני יצירת קריאה חדשה.', 'info');
      return;
    }
    /* ⭐ תגית קטנה בכותרת מספיקה כדי לזכור שהמערכת בניסוי. היא אינה
     * מספיקה כדי לא לשדר לתחנה בטעות, ולכן לפני שידור הניסוח המלא
     * עדיין מוצג — ודורש אישור מפורש. */
    if (isTrial() && !window.confirm(TRIAL_BROADCAST_WARNING)) {
      setMessage(session.elements.message, 'השידור בוטל. לא נשלחה קריאה.', 'info');
      return;
    }
    if (!session.pendingRequest) {
      const raw = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
      session.pendingRequest = { message, id:String(raw).replace(/[^A-Za-z0-9_-]/g, '_'),
        uids:Array.isArray(currentUids) ? currentUids.slice() : null };
    }
    session.elements.input.readOnly = true;
    session.elements.send.disabled = true;
    setMessage(session.elements.message, 'שולח קריאת פתע…', 'info');
    try {
      const payload = Array.isArray(session.pendingRequest.uids)
        ? { target:'people', crew, uids:session.pendingRequest.uids.slice(), text:message,
            request_id:session.pendingRequest.id, ...(isSuper ? { target_station_id:sid } : {}) }
        : { target:'crew:' + crew, text:message,
            request_id:session.pendingRequest.id, ...(isSuper ? { target_station_id:sid } : {}) };
      const response = await session.sendCallout(payload);
      if (active !== session) return;
      const data = response && response.data ? response.data : {};
      if (data.ok === false && data.retryable === true) {
        const wait = Math.max(500, Math.min(120000, Number(data.retry_after_ms) || 1000));
        session.pendingRequest.retries = Number(session.pendingRequest.retries || 0) + 1;
        if (session.pendingRequest.retries <= 3) {
          setMessage(session.elements.message, 'השליחה עדיין מתבצעת. מנסה שוב אוטומטית…', 'info');
          clearTimeout(session.retryTimer);
          session.retryTimer = setTimeout(() => { session.retryTimer = null; sendPending(true); }, wait);
          return;
        }
        setMessage(session.elements.message,
          'חלק מהנמענים טרם קיבלו את הקריאה. אפשר לנסות שוב; אותה קריאה תימשך ללא כפילות.', 'err');
        return;
      }
      if (data.ok === false) {
        session.elements.input.readOnly = false;
        session.pendingRequest = null;
        session.resumeStarted = false;
        // 42H.20 Scope 11 (closure batch item 6): dead_letter is terminal on
        // the server (bounded delivery_attempts, see functions/index.js's
        // MAX_CALLOUT_DELIVERY_ATTEMPTS) - do not word this like the other
        // failure cases that invite "try again", since trying again here
        // does nothing (the server no longer retries these uids at all).
        const deadCount = Array.isArray(data.dead_letter_uids) ? data.dead_letter_uids.length : 0;
        setMessage(session.elements.message,
          data.closed === true ? 'הקריאה כבר נסגרה ולא נשלחה שוב.'
          : data.dead_letter === true
            ? 'הקריאה כבר קיבלה מספר ניסיונות מסירה ולא הצליחה להגיע ל-' + deadCount +
              ' נמענים. המערכת הפסיקה לנסות אוטומטית — צריך לפנות אליהם בדרך אחרת.'
            : 'הקריאה לא נשלחה. נסה שוב.', 'err');
        return;
      }
      setMessage(session.elements.message,
        'הקריאה נשלחה ל־' + Number(data.sent || 0) + ' נמענים.', 'ok');
      if (text(session.elements.input.value, 300) === message) session.elements.input.value = '';
      session.elements.input.readOnly = false;
      session.pendingRequest = null;
      session.resumeStarted = false;
    } catch (error) {
      if (active === session) setMessage(session.elements.message,
        (logError('callout send', error), 'שליחת הקריאה נכשלה. ' + errorText(error)), 'err');
    } finally {
      if (active === session) session.elements.send.disabled = false;
    }
  };
  session.resumeDelivery = () => sendPending(true);
  session.elements.send.onclick = () => sendPending(false);

  // Both reads begin only after the actual signed role, station and crew have
  // passed the fail-closed gate above.
  const stopCallouts = watchOwnCallouts(session);
  session.stop = () => {
    try { stopCallouts(); } catch (_) {}
    clearTimeout(session.retryTimer);
    session.responseStops.forEach(stop => { try { stop(); } catch (_) {} });
    session.responseStops.clear();
  };
  renderRecipients(session);
  await reloadRoster(session);
  return Object.freeze({ hasPending:() => active === session && !!session.pendingRequest,
    destroy:() => { if (active === session) destroyCalloutConsole(); } });
}

export const CALLOUT_CONSOLE_ROLES = ALLOWED_ROLES;
