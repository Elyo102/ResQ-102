import { collection, query, where, orderBy, limit, onSnapshot, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { CREW_HE } from './rotation.js?v=42h19';

const ALLOWED_ROLES = Object.freeze(['commander', 'deputy']);
let active = null;

function text(value, max) {
  return String(value == null ? '' : value).normalize('NFC').trim().slice(0, max);
}

function validStation(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(value || ''));
}

function validCrew(value) {
  return ['A', 'B', 'C'].includes(String(value || ''));
}

function setMessage(element, value, kind) {
  element.textContent = value || '';
  element.className = 'msg ' + (value ? (kind || '') : '');
}

function rosterName(session, uid) {
  const person = session.roster.get(uid);
  return person && person.name ? person.name : 'לא בסגל';
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
          await session.closeCallout({ id });
        } catch (error) {
          close.disabled = false;
          setMessage(session.elements.message,
            'סגירת הקריאה נכשלה. (' + (error.code || error.message || 'שגיאה') + ')', 'err');
        }
      };
      card.appendChild(close);
    }
    box.appendChild(card);
  });
}

async function loadRoster(session) {
  // This function is reached only after initCalloutConsole has accepted the
  // signed claims. A denied role never starts a roster read.
  const snap = await getDocs(collection(session.db, 'stations', session.sid, 'roster'));
  if (active !== session) return;
  snap.forEach(doc => {
    const value = doc.data() || {};
    if (value.is_active === false) return;
    session.roster.set(doc.id, { name:text(value.full_name, 120) });
  });
}

function watchOwnCallouts(session) {
  const source = query(collection(session.db, 'stations', session.sid, 'callouts'),
    where('by_uid', '==', session.uid), orderBy('created_key', 'desc'), limit(10));
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
      if (!session.pendingRequest && value.active !== false &&
          ['reserved','delivering','partial'].includes(String(value.delivery_state || '')) &&
          /^[A-Za-z0-9_-]{16,80}$/.test(String(value.request_id || '')) && text(value.text, 300)) {
        session.pendingRequest = {
          id:String(value.request_id), message:text(value.text, 300), retries:0
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
        'מעקב התגובות אינו זמין כרגע. (' + (error.code || error.message || 'שגיאה') + ')', 'err');
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
      'תגובות הקריאה אינן זמינות כרגע. (' + (error.code || error.message || 'שגיאה') + ')', 'err');
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
  const sid = String(claims.stationId || '');
  const crew = String(claims.shift || '');
  if (options.readOnly === true || options.rolePreview === true ||
      !ALLOWED_ROLES.includes(role) || !validStation(sid) || !validCrew(crew)) {
    throw new Error('callout-console-permission-denied');
  }
  if (!options.user || !options.user.uid || !options.db || !options.functions ||
      !options.sdk || typeof options.sdk.httpsCallable !== 'function' || !options.elements) {
    throw new Error('callout-console-invalid-options');
  }

  const session = {
    db:options.db, sid, crew, role, uid:String(options.user.uid), elements:options.elements,
    roster:new Map(), callouts:new Map(), responses:new Map(), responseStops:new Map(), stop:() => {},
    pendingRequest:null, retryTimer:null, resumeStarted:false, resumeDelivery:null,
    sendCallout:options.sdk.httpsCallable(options.functions, 'sendCallout'),
    closeCallout:options.sdk.httpsCallable(options.functions, 'closeCallout')
  };
  active = session;
  session.elements.crew.textContent = CREW_HE[crew] || ('משמרת ' + crew);
  const sendPending = async autoRetry => {
    if (active !== session) return;
    const typedMessage = text(session.elements.input.value, 300);
    const message = autoRetry && session.pendingRequest
      ? session.pendingRequest.message : typedMessage;
    if (!message) {
      setMessage(session.elements.message, 'צריך לכתוב את הודעת הקריאה.', 'err');
      return;
    }
    if (!autoRetry && !window.confirm('להזעיק את ' + (CREW_HE[crew] || crew) + '?\n\n' + message)) return;
    if (session.pendingRequest && session.pendingRequest.message !== message) {
      session.elements.input.value = session.pendingRequest.message;
      setMessage(session.elements.message,
        'קריאה קודמת עדיין ממתינה למסירה; ממשיכים אותה לפני יצירת קריאה חדשה.', 'info');
      return;
    }
    if (!session.pendingRequest) {
      const raw = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
      session.pendingRequest = { message, id:String(raw).replace(/[^A-Za-z0-9_-]/g, '_') };
    }
    session.elements.input.readOnly = true;
    session.elements.send.disabled = true;
    setMessage(session.elements.message, 'שולח קריאת פתע…', 'info');
    try {
      const response = await session.sendCallout({ target:'crew:' + crew, text:message,
        request_id:session.pendingRequest.id });
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
        setMessage(session.elements.message,
          data.closed === true ? 'הקריאה כבר נסגרה ולא נשלחה שוב.' : 'הקריאה לא נשלחה. נסה שוב.', 'err');
        return;
      }
      setMessage(session.elements.message,
        'הקריאה נשלחה ל־' + Number(data.sent || 0) + ' אנשי משמרת.', 'ok');
      if (text(session.elements.input.value, 300) === message) session.elements.input.value = '';
      session.elements.input.readOnly = false;
      session.pendingRequest = null;
      session.resumeStarted = false;
    } catch (error) {
      if (active === session) setMessage(session.elements.message,
        'שליחת הקריאה נכשלה. (' + (error.code || error.message || 'שגיאה') + ')', 'err');
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
  try { await loadRoster(session); } catch (error) {
    if (active === session) setMessage(session.elements.message,
      'רשימת השמות לא נטענה; מוני התגובות ימשיכו להתעדכן.', 'info');
  }
  return Object.freeze({ destroy:() => { if (active === session) destroyCalloutConsole(); } });
}

export const CALLOUT_CONSOLE_ROLES = ALLOWED_ROLES;
