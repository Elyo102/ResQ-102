import { collection, query, where, orderBy, limit, onSnapshot, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { CREW_HE } from './rotation.js?v=42h32';
import { errorText, logError } from './error-text.js?v=42h32';
import { isTrial, TRIAL_BROADCAST_WARNING } from './mode-bar.js?v=42h32';
import { readCalloutRosterCache, writeCalloutRosterCache } from './callout-roster-cache.js?v=42h32';

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

function firstSuccessful(promises) {
  return new Promise((resolve, reject) => {
    let left = promises.length;
    const errors = [];
    promises.forEach(promise => Promise.resolve(promise).then(resolve, error => {
      errors.push(error);
      left -= 1;
      if (!left) reject(errors[0] || error);
    }));
  });
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
  list.setAttribute('aria-busy', session.rosterLoaded ? 'false' : 'true');
  if (session.elements.recipientNone) {
    session.elements.recipientNone.disabled = !session.rosterLoaded || session.rosterFailed || !rows.length;
  }
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
    const mark = document.createElement('span');
    mark.className = 'recipient-check';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '✓';
    const name = document.createElement('span');
    name.textContent = person.name || person.uid;
    const meta = document.createElement('small');
    meta.textContent = person.uid === session.uid ? 'אני' : (CREW_HE[person.crew] || person.crew || '');
    label.append(input, mark, name, meta);
    list.appendChild(label);
  });
  const picked = selectedUids(session);
  syncRecipientMode(session, picked);
  if (session.elements.recipientSummary) {
    session.elements.recipientSummary.textContent = session.rosterFailed
      ? 'רשימת הלוחמים לא זמינה כרגע. אפשר לנסות שוב, לשלוח לכל המשמרת או לבצע בדיקת עצמי.'
      : picked
      ? (picked.length
        ? 'בחירה פרטנית פעילה: הקריאה תישלח ל־' + selectionLabel(session, picked) + '.'
        : 'בחירה פרטנית פעילה: לא נבחרו נמענים.')
      : (session.rosterLoaded
        ? 'ברירת מחדל: כל אנשי ' + (CREW_HE[session.crew] || ('משמרת ' + session.crew)) + '. אפשר לבחור לוחמים ספציפיים מהרשימה.'
        : 'טוען רשימת לוחמים לבחירה פרטנית…');
    if (session.rosterSource === 'cache' && session.rosterLoaded) {
      session.elements.recipientSummary.textContent += ' הרשימה השמורה מתעדכנת כעת ברקע.';
    }
  }
}

function renderLive(session, list) {
  if (active !== session) return;
  const box = session.elements.live;
  session.elements.liveCard.classList.toggle('hide', list.length === 0);
  box.replaceChildren();

  list.forEach(({ id, value }) => {
    const rehearsal = value.rehearsal === true;
    const uids = rehearsal && Array.isArray(value.rehearsal_uids)
      ? value.rehearsal_uids : (Array.isArray(value.uids) ? value.uids : []);
    const legacy = value.acks && typeof value.acks === 'object' ? value.acks : {};
    const modern = value.responses && typeof value.responses === 'object' ? value.responses : {};
    const acks = { ...legacy, ...modern };
    // A response is evidence for this callout only when its uid belongs to the
    // immutable dispatch audience. Old/corrupt response rows must not inflate
    // a commander's live totals. Legacy rows without uids keep their historical
    // behaviour until they are closed.
    const canonical = uids.length ? new Set(uids) : null;
    const coming = [], unavailable = [], seenOnly = [];
    Object.keys(acks).filter(uid => !canonical || canonical.has(uid)).forEach(uid => {
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
    const sentNames = uids.map(uid => rosterName(session, uid));
    const viewedCount = coming.length + unavailable.length + seenOnly.length;

    const card = document.createElement('article');
    card.className = 'callout-row' + (rehearsal ? ' rehearsal' : '');
    const heading = document.createElement('strong');
    heading.textContent = (value.target_he || ('משמרת ' + session.crew)) +
      (rehearsal ? ' · תרגול ללא שידור' : (value.active === false ? ' · סגורה' : ''));
    const body = document.createElement('p');
    body.textContent = text(value.text, 300);
    const tally = document.createElement('div');
    tally.className = 'tally';
    tally.textContent = 'טרם הוצג ' + pendingNames.length + ' · הוצג, טרם ענה ' + seenOnly.length;
    const metrics = document.createElement('div');
    metrics.className = 'callout-metrics';
    [
      [rehearsal ? 'נבחרו לתרגול' : 'נשלח אל', uids.length],
      ['נצפה', viewedCount],
      ['אישרו / בדרך', coming.length],
      ['דחו', unavailable.length]
    ].forEach(([label, count]) => {
      const metric = document.createElement('div');
      const number = document.createElement('strong');
      const caption = document.createElement('span');
      number.textContent = String(count);
      caption.textContent = label;
      // Label precedes the number in DOM order so screen readers announce
      // the meaning before the value; CSS still gives the number emphasis.
      metric.append(caption, number);
      metrics.appendChild(metric);
    });
    card.append(heading, body, metrics, tally);

    if (sentNames.length) {
      const row = document.createElement('small');
      row.className = 'callout-sent-to';
      row.textContent = (rehearsal ? 'נבחרו לתרגול: ' : 'נשלח אל: ') + sentNames.join(', ');
      card.appendChild(row);
    }

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
  return Array.isArray(data.recipients) ? data.recipients : [];
}

async function loadRosterFromFirestore(session) {
  // Fallback only. The authoritative picker path is the callable above; this
  // keeps older deployments usable while functions and hosting roll forward.
  const rosterQuery = query(collection(session.db, 'stations', session.sid, 'roster'),
    where('crew', '==', session.crew));
  const snap = await withTimeout(getDocs(rosterQuery),
    rosterLoadTimeoutMs(), 'callout-roster-timeout');
  const rows = [];
  snap.forEach(doc => {
    const value = doc.data() || {};
    rows.push({ uid:doc.id, name:value.full_name, crew:value.crew, is_active:value.is_active });
  });
  return rows.filter(row => row.is_active !== false);
}

async function loadRoster(session) {
  // This function is reached only after initCalloutConsole has accepted the
  // signed claims. A denied role never starts a recipient read.
  //
  // The callable is the authoritative picker path, but a cold Cloud Function
  // must not leave the commander staring at "טוען" while the roster is already
  // readable. Start both safe reads together and paint the first successful
  // answer; if the authoritative callable returns later it refreshes the same
  // list. The send path still goes through `sendCallout`, which re-filters all
  // selected uids server-side before delivery.
  const loadId = Number(session.rosterLoadId || 0) + 1;
  session.rosterLoadId = loadId;
  session.rosterSource = '';
  const source = async (label, loader) => {
    try {
      const rows = await loader(session);
      if (active !== session || session.rosterLoadId !== loadId) return label;
      // Firestore is a quick availability fallback. Once the callable has
      // returned, a slower/stale fallback must never replace its authoritative
      // answer. If fallback wins the race it may paint immediately; the
      // callable is still allowed to refresh it when it arrives.
      if (label === 'firestore' && session.rosterSource === 'server') return label;
      applyRosterRows(session, rows);
      session.rosterSource = label;
      session.rosterFailed = false;
      session.rosterLoaded = true;
      writeCalloutRosterCache(session, rows);
      renderRecipients(session);
      return label;
    } catch (error) {
      logError('callout recipients ' + label, error);
      throw error;
    }
  };
  await firstSuccessful([
    source('server', loadRosterFromServer),
    source('firestore', loadRosterFromFirestore)
  ]);
}

async function reloadRoster(session) {
  if (active !== session) return;
  const hasCachedRows = session.rosterSource === 'cache' && session.roster.size > 0;
  session.rosterFailed = false;
  session.rosterLoaded = hasCachedRows;
  renderRecipients(session);
  try {
    await loadRoster(session);
  } catch (error) {
    if (active !== session) return;
    session.rosterFailed = !hasCachedRows;
    session.rosterLoaded = true;
    renderRecipients(session);
    setMessage(session.elements.message,
      hasCachedRows
        ? 'מוצגת רשימה שמורה. הרענון נכשל, והשרת יאמת מחדש כל נמען בזמן השליחה. ' + errorText(error)
        : 'רשימת השמות לא נטענה כרגע. אפשר לשלוח לכל המשמרת או לבצע בדיקת עצמי. ' + errorText(error),
      hasCachedRows ? 'info' : 'err');
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
  const cachedRows = readCalloutRosterCache(session);
  if (cachedRows.length) {
    applyRosterRows(session, cachedRows);
    session.rosterSource = 'cache';
    session.rosterLoaded = true;
  }
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
  const sendPending = async (autoRetry, rehearsalRequested) => {
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
    const rehearsal = autoRetry && session.pendingRequest
      ? session.pendingRequest.rehearsal === true : rehearsalRequested === true;
    if (!autoRetry && !window.confirm(rehearsal
      ? 'לשמור תרגול עבור ' + targetName + '?\n\nלא תישלח התראה, לא יושמע צליל והעובדים לא יראו את התרגול.\n\n' + message
      : 'להזעיק את ' + targetName + ' בתחנה ' + sid + '?\n\n' + message)) return;
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
    if (!rehearsal && isTrial() && !window.confirm(TRIAL_BROADCAST_WARNING)) {
      setMessage(session.elements.message, 'השידור בוטל. לא נשלחה קריאה.', 'info');
      return;
    }
    if (!session.pendingRequest) {
      const raw = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
      session.pendingRequest = { message, id:String(raw).replace(/[^A-Za-z0-9_-]/g, '_'), rehearsal,
        uids:Array.isArray(currentUids) ? currentUids.slice() : null };
    }
    session.elements.input.readOnly = true;
    session.elements.send.disabled = true;
    if (session.elements.rehearse) session.elements.rehearse.disabled = true;
    setMessage(session.elements.message, rehearsal ? 'שומר תרגול ללא שידור…' : 'שולח קריאת פתע…', 'info');
    try {
      const payload = Array.isArray(session.pendingRequest.uids)
        ? { target:'people', crew, uids:session.pendingRequest.uids.slice(), text:message,
            request_id:session.pendingRequest.id, ...(isSuper ? { target_station_id:sid } : {}) }
        : { target:'crew:' + crew, text:message,
            request_id:session.pendingRequest.id, ...(isSuper ? { target_station_id:sid } : {}) };
      if (rehearsal) payload.rehearsal = true;
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
      setMessage(session.elements.message, data.rehearsal === true
        ? 'התרגול נשמר. לא נשלחה התראה לאף עובד.'
        : 'הקריאה נשלחה ל־' + Number(data.sent || 0) + ' נמענים.', 'ok');
      if (text(session.elements.input.value, 300) === message) session.elements.input.value = '';
      session.elements.input.readOnly = false;
      session.pendingRequest = null;
      session.resumeStarted = false;
    } catch (error) {
      if (active === session) setMessage(session.elements.message,
        (logError('callout send', error), 'שליחת הקריאה נכשלה. ' + errorText(error)), 'err');
    } finally {
      if (active === session) {
        session.elements.send.disabled = false;
        if (session.elements.rehearse) session.elements.rehearse.disabled = false;
      }
    }
  };
  session.resumeDelivery = () => sendPending(true, false);
  session.elements.send.onclick = () => sendPending(false, false);
  if (session.elements.rehearse) session.elements.rehearse.onclick = () => sendPending(false, true);

  // Both reads begin only after the actual signed role, station and crew have
  // passed the fail-closed gate above.
  // בורר הנמענים הוא הפעולה הראשית. כשל סינכרוני בהפעלת המעקב
  // לא רשאי לעצור את ציור הרשימה ולהשאיר "טוען" לנצח.
  renderRecipients(session);
  void reloadRoster(session);
  let stopCallouts = () => {};
  try {
    stopCallouts = watchOwnCallouts(session) || stopCallouts;
  } catch (error) {
    logError('callout tracking start', error);
    if (session.elements.tracking) {
      setMessage(session.elements.tracking,
        'מעקב הקריאות אינו זמין כרגע. בחירת נמענים ושיגור עדיין זמינים.', 'err');
    }
  }
  session.stop = () => {
    try { stopCallouts(); } catch (_) {}
    clearTimeout(session.retryTimer);
    session.responseStops.forEach(stop => { try { stop(); } catch (_) {} });
    session.responseStops.clear();
  };
  // The callout console is operational before the optional name list arrives.
  // Full-crew dispatch and trial self-test stay available, while individual
  // selection is enabled only after a bounded roster read paints real rows.
  // This prevents a cold function or a stale Firestore connection from
  // holding the whole screen behind an indefinite loading state.
  return Object.freeze({ hasPending:() => active === session && !!session.pendingRequest,
    destroy:() => { if (active === session) destroyCalloutConsole(); } });
}

export const CALLOUT_CONSOLE_ROLES = ALLOWED_ROLES;
