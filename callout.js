// קריאת פתע.
//
// הודעה רגילה יכולה לחכות. קריאת פתע לא — היא קופצת על המסך
// של מי שקיבל אותה, בכל מסך שהוא נמצא בו, וממשיכה לקפוץ עד
// שהוא עונה. אי אפשר לכבות אותה בהעדפות, וזה בכוונה: מפקד
// שמזעיק את המשמרת צריך לדעת שההודעה הגיעה, לא לקוות.
//
// שני חלקים כאן:
//   watchCallouts  מאזין ומקפיץ. יושב בכל מסך.
//   ackCallout     התשובה — מגיע או לא זמין.
//
// כל תשובה נשמרת במסמך פרטי משלה מתחת לקריאה. כך נמען יכול
// לקרוא ולשנות רק את התשובה שלו, בעוד יוצר הקריאה רואה את
// התמונה המלאה במסוף הניהול.

import { collection, query, where, orderBy, limit, onSnapshot,
         doc, setDoc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { errorText, logError } from './error-text.js?v=42h31';

// כמה זמן קריאה נחשבת חיה. אחרי זה היא לא תקפוץ יותר גם אם
// אף אחד לא סגר אותה — קריאה מלפני שמונה שעות היא היסטוריה,
// לא הזעקה.
export const CALLOUT_TTL_MS = 8 * 60 * 60 * 1000;

export const ACKS = [
  { id: 'coming', he: 'מגיע',    color: 'var(--good)' },
  { id: 'no',     he: 'לא זמין', color: 'var(--muted)' }
];

/* ⭐ נימוקי דחייה מהירים.
 *
 * קודם לכן היה כאן שדה טקסט חופשי בלבד. כבאי שמקבל הזעקה
 * בשתיים בלילה אינו מנסח משפט, והמפקד שקורא את התשובות
 * צריך לספור כמה במילואים — לא לקרוא עשרים ניסוחים שונים
 * לאותו דבר. הטקסט החופשי נשאר תחת „אחר", כדי שלא נאלץ
 * אדם לבחור סיבה שאינה נכונה.
 *
 * אפס שינוי בשרת: השדה היה ונשאר מחרוזת חופשית, והכללים
 * דורשים רק שלא תהיה ריקה. הבחירה נשלחת כטקסט שלה. */
export const REJECT_REASONS = Object.freeze([
  { id: 'sick',    he: 'מחלה מאושרת' },
  { id: 'reserve', he: 'שירות מילואים' },
  { id: 'exempt',  he: 'פטור מאושר' },
  { id: 'away',    he: 'איני זמין בתחנה' },
  { id: 'other',   he: 'אחר' }
]);

const seenWrites = new Map();

export function ackHe(id) {
  const a = ACKS.filter(function (x) { return x.id === id; })[0];
  return a ? a.he : '';
}

function fresh(v) {
  const t = Date.parse(String((v || {}).created_key || '')) || 0;
  if (!t) return true;                       // אין חותמת — לא מסתירים
  return (Date.now() - t) < CALLOUT_TTL_MS;
}

// ------------------------------------------------------------------
//  הקפצה
// ------------------------------------------------------------------

function styleOnce() {
  if (document.getElementById('coStyle')) return;
  const st = document.createElement('style');
  st.id = 'coStyle';
  st.textContent = [
    '#coWrap{position:fixed;inset:0;z-index:99999;display:none;',
    '  background:rgba(10,4,4,.92);direction:rtl;',
    '  font-family:"Segoe UI",Arial,sans-serif;',
    '  align-items:center;justify-content:center;padding:20px;',
    '  overflow:auto}',
    '#coWrap.on{display:flex}',
    '#coBox{background:#241315;border:2px solid #ef5350;border-radius:16px;',
    '  max-width:520px;width:100%;padding:24px;color:#e8eaed;',
    '  box-shadow:0 18px 60px rgba(0,0,0,.6)}',
    '#coBox .kicker{display:flex;align-items:center;gap:9px;',
    '  color:#ff8a80;font-size:13px;font-weight:800;letter-spacing:.04em}',
    '#coBox .kicker i{width:11px;height:11px;border-radius:50%;',
    '  background:#ef5350;flex:none;animation:coPulse 1s infinite}',
    '@keyframes coPulse{0%,100%{opacity:1}50%{opacity:.25}}',
    '@media (prefers-reduced-motion:reduce){',
    '  #coBox .kicker i{animation:none}}',
    '#coBox h2{font-size:26px;margin:8px 0 2px;color:#fff;font-weight:800}',
    '#coBox .from{color:#c6a9a9;font-size:13px;margin-bottom:16px}',
    '#coBox .text{background:#1a0e10;border:1px solid #4a2a2c;',
    '  border-radius:11px;padding:17px;font-size:19px;line-height:1.65;',
    '  font-weight:600;white-space:pre-wrap;word-break:break-word}',
    '#coBox .ask{color:#c6a9a9;font-size:13px;margin:16px 0 8px}',
    '#coBox .btns{display:flex;gap:10px;flex-wrap:wrap}',
    '#coBox button{flex:1 1 140px;padding:15px;border-radius:11px;',
    '  font-family:inherit;font-size:16px;font-weight:800;cursor:pointer;',
    '  border:1px solid #3a3f47;background:transparent;color:#b9c0c8;',
    '  width:auto;margin:0}',
    '#coBox button.go{background:#2e7d32;border-color:#2e7d32;color:#fff}',
    '#coBox button:disabled{opacity:.55;cursor:not-allowed}',
    '#coBox .more{color:#9aa0a6;font-size:12px;margin-top:12px}',
    '#coBox .reason{margin-top:12px}',
    '#coBox .reason[hidden]{display:none!important}',
    '#coBox .reason label{display:block;color:#ffccbc;font-size:13px;margin-bottom:6px}',
    '#coBox .reason textarea{box-sizing:border-box;width:100%;min-height:78px;',
    '  resize:vertical;border:1px solid #6d4548;border-radius:9px;padding:10px;',
    '  background:#1a0e10;color:#fff;font:inherit;margin-top:10px}',
    '#coBox .reason textarea[hidden]{display:none!important}',
    '#coBox .rlist{display:flex;flex-direction:column;gap:8px}',
    '#coBox .rlist button{flex:none;width:100%;text-align:start;padding:13px 14px;',
    '  font-size:15px;font-weight:600}',
    '#coBox .rlist button[aria-pressed="true"]{background:#4a2a2c;border-color:#ef5350;',
    '  color:#fff}',
    '#coBox .reason .btns{margin-top:12px}',
    /* מצב ההצלחה. ירוק וגדול דיו כדי שאפשר יהיה לראות אותו
     * במבט אחד, כי זה כל הזמן שיש למי שכבר בדרך לרכב. */
    '#coBox .done{margin-top:14px;padding:14px;border-radius:11px;',
    '  background:#14301a;border:1px solid #2e7d32;color:#c8e6c9;',
    '  font-size:17px;font-weight:800;text-align:center}',
    '#coBox .done[hidden]{display:none!important}',
    '#coBox .err{color:#ef9a9a;font-size:13px;margin-top:10px;display:none}'
  ].join('');
  document.head.appendChild(st);
}

function box() {
  styleOnce();
  let w = document.getElementById('coWrap');
  if (w) return w;
  w = document.createElement('div');
  w.id = 'coWrap';
  w.innerHTML =
    '<div id="coBox" role="alertdialog" aria-live="assertive">' +
      '<div class="kicker"><i></i><span>קריאת פתע</span></div>' +
      '<h2 id="coTitle">התייצבות בתחנה</h2>' +
      '<div class="from" id="coFrom"></div>' +
      '<div class="text" id="coText"></div>' +
      '<div class="ask">המפקד ממתין לתשובה שלך.</div>' +
      '<div class="btns" id="coBtns">' +
        '<button class="go" id="coYes">מגיע</button>' +
        '<button id="coNo">לא זמין</button>' +
      '</div>' +
      '<div class="reason" id="coReasonWrap" hidden>' +
        '<label for="coReason" id="coReasonLabel">מה הסיבה? (חובה)</label>' +
        '<div class="rlist" id="coReasons" role="group" aria-labelledby="coReasonLabel"></div>' +
        '<textarea id="coReason" maxlength="200" hidden ' +
          'placeholder="כתבו בקצרה מדוע אינכם יכולים להגיע"></textarea>' +
        '<div class="btns">' +
          '<button class="go" id="coSend" disabled>שלח דחייה</button>' +
          '<button id="coBack">חזרה</button>' +
        '</div>' +
      '</div>' +
      '<div class="done" id="coDone" hidden></div>' +
      '<div class="more" id="coMore"></div>' +
      '<div class="err" id="coErr"></div>' +
    '</div>';
  document.body.appendChild(w);
  return w;
}

// צליל וריטוט. הדפדפן חוסם את שניהם עד שהמשתמש נגע בדף, וגם
// כותב על כך לקונסולה — ולכן בודקים לפני ולא מנסים בכוח.
//
// זה לא מחסיר כלום בפועל: כשהאפליקציה פתוחה והמשתמש עובד בה,
// הוא כבר נגע. כשהיא סגורה, ההתראה מ-FCM היא זו שמצלצלת,
// והחלון הזה רק ממתין לו בפנים.
function canRing() {
  const ua = navigator.userActivation;
  return ua ? ua.hasBeenActive === true : true;
}

function alarm() {
  if (!canRing()) return;
  try { if (navigator.vibrate) navigator.vibrate([300, 120, 300, 120, 500]); }
  catch (ignore) {}
  const fallback = function () {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      [0, 0.45].forEach(function (at) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'square';
        o.frequency.setValueAtTime(880, ctx.currentTime + at);
        g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.32);
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + at);
        o.stop(ctx.currentTime + at + 0.35);
      });
      setTimeout(function () { try { ctx.close(); } catch (ignore) {} }, 1500);
    } catch (ignore) {}
  };
  try {
    const selected = new Audio('./callout-siren.mp3?v=42h31');
    selected.preload = 'auto';
    selected.volume = 1;
    const playback = selected.play();
    if (playback && typeof playback.catch === 'function') playback.catch(fallback);
    return;
  } catch (ignore) { fallback(); }
}

export async function ackCallout(db, sid, calloutId, uid, name, answer, reason) {
  const cleanReason = answer === 'no' ? String(reason || '').trim().slice(0, 200) : '';
  if (answer === 'no' && !cleanReason) {
    return Promise.reject(new Error('callout-rejection-reason-required'));
  }
  // רשת איטית יכולה להביא את הלחיצה לפני שסימון הצפייה הראשון
  // הושלם. נסיון נוסף מבטיח שהרשומה קיימת; אם היא כבר קיימת
  // הכללים ידחו שינוי של חותמת הצפייה המקורית ואפשר להמשיך.
  await markCalloutSeen(db, sid, calloutId, uid).catch(function () {});
  return setDoc(
    doc(db, 'stations', sid, 'callouts', calloutId, 'responses', uid),
    { resp: answer, name: name || '', at: new Date().toISOString(), reason:cleanReason },
    { merge:true }
  );
}

// עצם הצגת הקריאה היא מידע תפעולי נפרד מהתשובה. הרשומה
// נשמרת במיזוג כדי שתשובה מקבילה או חוזרת לא תאבד את seen_at,
// וכדי שסימון הצפייה לעולם לא ימחק תשובה שכבר נכתבה.
export function markCalloutSeen(db, sid, calloutId, uid) {
  const key = [sid, calloutId, uid].join('/');
  if (seenWrites.has(key)) return seenWrites.get(key);
  const pending = setDoc(
    doc(db, 'stations', sid, 'callouts', calloutId, 'responses', uid),
    { seen_at:new Date().toISOString() },
    { merge:true }
  ).catch(function (error) {
    seenWrites.delete(key);
    throw error;
  });
  seenWrites.set(key, pending);
  return pending;
}

// מאזין לקריאות שנוגעות למשתמש הזה ומקפיץ את הראשונה שעדיין
// לא ענה עליה. מחזיר פונקציית ביטול.
//
// אין כאן סגירה בלי תשובה: אין כפתור X ואין לחיצה על הרקע.
// הדרך היחידה החוצה היא לענות — וזו כל הנקודה.
// ------------------------------------------------------------------
//  פס מצב ניסוי
// ------------------------------------------------------------------
//
//  **למה הפס הזה קיים.** במצב ניסוי אף התראה לא יוצאת. בלי
//  סימן על המסך, מפקד שישלח קריאת פתע ולא יראה תגובה יסיק
//  שההזעקה שבורה — ויתקשר לכולם בטלפון. "שקט" ו"שבור" נראים
//  אותו דבר בדיוק, וזה ההבדל היחיד שאפשר להראות.
//
//  **ולמה הוא יושב כאן.** watchCallouts נקראת מכל מסך במערכת,
//  ויש לה כבר db. הוספת הפס לכל מסך בנפרד הייתה שבע-עשרה
//  עריכות שאחת מהן נשכחת — והמסך שנשכח הוא זה שמישהו יעבוד
//  בו כשהוא ישכח שהמערכת שקטה.

let activeOwner = null;
let ownerSerial = 0;

function clearCalloutUi() {
  releaseKeyboardWatch();
  const w = document.getElementById('coWrap');
  if (!w) return;
  w.classList.remove('on');
  ['coText', 'coFrom', 'coMore', 'coErr', 'coDone'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });
  const reason = document.getElementById('coReason');
  if (reason) { reason.value = ''; reason.hidden = true; }
  const reasons = document.getElementById('coReasons');
  if (reasons) reasons.replaceChildren();
  const err = document.getElementById('coErr');
  if (err) err.style.display = 'none';
  const reasonWrap = document.getElementById('coReasonWrap');
  if (reasonWrap) reasonWrap.hidden = true;
  const done = document.getElementById('coDone');
  if (done) done.hidden = true;
  const btns = document.getElementById('coBtns');
  if (btns) btns.hidden = false;
  const yes = document.getElementById('coYes');
  if (yes) yes.textContent = 'מגיע';
  const send = document.getElementById('coSend');
  if (send) send.textContent = 'שלח דחייה';
  ['coYes', 'coNo', 'coSend', 'coBack'].forEach(function (id) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = id === 'coSend';
    btn.onclick = null;
  });
}

/* ⭐ המקלדת בטלפון.
 *
 * פתיחת שדה הטקסט מעלה מקלדת שתופסת כמחצית המסך. בלי
 * הטיפול הזה, כפתור „שלח דחייה" נשאר מתחת למקלדת ב-320 ו-360,
 * והמשתמש כותב נימוק ולא מוצא איך לשלוח אותו. `visualViewport`
 * הוא הדבר היחיד שבאמת מדווח על המקלדת; אין אירוע אחר. */
let keyboardStop = null;

function releaseKeyboardWatch() {
  if (!keyboardStop) return;
  try { keyboardStop(); } catch (ignore) {}
  keyboardStop = null;
}

function keepSendVisible() {
  const send = document.getElementById('coSend');
  if (!send || send.hidden) return;
  try { send.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (ignore) {}
}

function watchKeyboard() {
  releaseKeyboardWatch();
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return;
  const onResize = function () { keepSendVisible(); };
  vv.addEventListener('resize', onResize);
  keyboardStop = function () { vv.removeEventListener('resize', onResize); };
}

export function watchCallouts(db, sid, uid, opts) {
  if (!db || !sid || !uid) return function () {};
  if (activeOwner && typeof activeOwner.dispose === 'function') {
    activeOwner.dispose();
  }

  const owner = {
    id: ++ownerSerial,
    disposed: false,
    stop: function () {},
    dispose: null,
    answered: new Set(),
    legacyAnswered: new Set(),
    responseStops: new Map(),
    doneTimer: null,
    latest: []
  };
  owner.dispose = function () {
    if (owner.disposed) return;
    owner.disposed = true;
    try { owner.stop(); } catch (ignore) {}
    owner.responseStops.forEach(function (responseStop) {
      try { responseStop(); } catch (ignore) {}
    });
    owner.responseStops.clear();
    if (owner.doneTimer) { clearTimeout(owner.doneTimer); owner.doneTimer = null; }
    if (activeOwner !== owner) return;
    activeOwner = null;
    clearCalloutUi();
  };
  activeOwner = owner;
  const o = opts || {};
  let shownId = '';

  function renderLatest() {
    if (activeOwner !== owner || owner.disposed) return;
    const list = owner.latest.filter(function (row) {
      return row.v.active !== false && fresh(row.v) &&
        !owner.answered.has(row.id) && !owner.legacyAnswered.has(row.id);
    });
    if (!list.length) {
      /* ⭐ המאזין מסיר את הקריאה ברגע שהתשובה נכתבה — מהר מכדי
       * לקרוא את האישור. כל עוד שעון האישור רץ, הוא זה שיסגור. */
      if (!owner.doneTimer) {
        const w = document.getElementById('coWrap');
        if (w) w.classList.remove('on');
      }
      shownId = '';
      return;
    }
    const cur = list[0];
    if (cur.id === shownId) return;
    shownId = cur.id;
    show(owner, db, sid, uid, cur.id, cur.v, o, list.length);
  }

  function watchOwnResponse(calloutId) {
    if (owner.responseStops.has(calloutId)) return;
    const responseRef = doc(db, 'stations', sid, 'callouts', calloutId, 'responses', uid);
    const responseStop = onSnapshot(responseRef, function (snap) {
      if (activeOwner !== owner || owner.disposed) return;
      const value = snap.exists() ? (snap.data() || {}) : {};
      if (value.resp === 'coming' || value.resp === 'no') owner.answered.add(calloutId);
      else owner.answered.delete(calloutId);
      renderLatest();
    }, function () {});
    owner.responseStops.set(calloutId, responseStop);
  }

  const q = query(
    collection(db, 'stations', sid, 'callouts'),
    where('uids', 'array-contains', uid),
    where('active', '==', true),
    orderBy('created_key', 'desc'),
    limit(5)
  );

  let stop = function () {};
  try {
    stop = onSnapshot(q, function (snap) {
      if (activeOwner !== owner || owner.disposed) return;
      const list = [];
      const ids = new Set();
      snap.forEach(function (d) {
        const v = d.data() || {};
        ids.add(d.id);
        const legacy = v.acks && typeof v.acks === 'object' ? v.acks : {};
        if (Object.prototype.hasOwnProperty.call(legacy, uid)) owner.legacyAnswered.add(d.id);
        else owner.legacyAnswered.delete(d.id);
        watchOwnResponse(d.id);
        list.push({ id: d.id, v: v });
      });
      owner.responseStops.forEach(function (responseStop, id) {
        if (ids.has(id)) return;
        try { responseStop(); } catch (ignore) {}
        owner.responseStops.delete(id);
        owner.answered.delete(id);
        owner.legacyAnswered.delete(id);
      });
      owner.latest = list;
      renderLatest();
    }, function (err) {
      if (activeOwner !== owner || owner.disposed) return;
      // מאזין שנפל לא אמור להפיל את המסך שמתחתיו.
      console.warn('callout watch: ' + (err && err.message));
    });
  } catch (e) {
    console.warn('callout watch: ' + (e && e.message));
  }

  owner.stop = stop;
  return owner.dispose;
}

function show(owner, db, sid, uid, id, v, o, count) {
  if (activeOwner !== owner || owner.disposed) return;
  const w = box();
  const t = document.getElementById('coText');
  const f = document.getElementById('coFrom');
  const m = document.getElementById('coMore');
  const e = document.getElementById('coErr');

  t.textContent = String(v.text || '');
  f.textContent = [v.by_name || 'מפקד', v.by_role_he || '', v.when_he || '']
    .filter(Boolean).join(' · ');
  m.textContent = count > 1 ? 'יש עוד ' + (count - 1) + ' קריאות ממתינות.' : '';
  e.style.display = 'none';
  e.textContent = '';

  const btns = document.getElementById('coBtns');
  const yes = document.getElementById('coYes');
  const no  = document.getElementById('coNo');
  const reasonWrap = document.getElementById('coReasonWrap');
  const reasonList = document.getElementById('coReasons');
  const reason = document.getElementById('coReason');
  const send = document.getElementById('coSend');
  const back = document.getElementById('coBack');
  const done = document.getElementById('coDone');

  let chosen = null;
  let sending = false;

  releaseKeyboardWatch();
  btns.hidden = false;
  reasonWrap.hidden = true;
  done.hidden = true;
  done.textContent = '';
  reason.hidden = true;
  reason.value = '';
  yes.textContent = 'מגיע';
  send.textContent = 'שלח דחייה';
  yes.disabled = false; no.disabled = false; back.disabled = false;

  /* ⭐ הכפתור מנוטרל עד שיש נימוק, ולא „פעיל ואז נכשל".
   * לפני כן הוא נראה לחיץ, והודעת השגיאה הגיעה רק אחרי לחיצה. */
  function reasonText() {
    if (!chosen) return '';
    if (chosen.id === 'other') return String(reason.value || '').trim().slice(0, 200);
    return chosen.he;
  }
  function updateSend() {
    send.disabled = sending || !reasonText();
  }

  function renderReasons() {
    reasonList.replaceChildren();
    REJECT_REASONS.forEach(function (item) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = item.he;
      b.dataset.reason = item.id;
      b.setAttribute('aria-pressed', String(!!chosen && chosen.id === item.id));
      b.onclick = function () {
        if (sending) return;
        chosen = item;
        reason.hidden = item.id !== 'other';
        e.style.display = 'none';
        renderReasons();
        updateSend();
        if (item.id === 'other') {
          watchKeyboard();
          reason.focus();
          keepSendVisible();
        } else {
          releaseKeyboardWatch();
        }
      };
      reasonList.append(b);
    });
  }

  function lock(on) {
    sending = on;
    yes.disabled = on; no.disabled = on; back.disabled = on;
    reason.disabled = on;
    reasonList.querySelectorAll('button').forEach(function (b) { b.disabled = on; });
    updateSend();
  }

  /* מצב ההצלחה.
   *
   * קודם לכן החלון פשוט נעלם, וזה היה כל האישור שקיבל אדם
   * שעונה להזעקה. מסך שהתרוקן נראה בדיוק כמו מסך שקרס,
   * והדבר הבא שקורה הוא לחיצה שנייה. */
  function succeed(which) {
    if (activeOwner !== owner || owner.disposed) return;
    releaseKeyboardWatch();
    btns.hidden = true;
    reasonWrap.hidden = true;
    done.textContent = which === 'coming'
      ? '✓ אישרת הגעה. התשובה נשמרה והמפקד רואה אותה.'
      : '✓ הדחייה נשלחה. התשובה נשמרה והמפקד רואה אותה.';
    done.hidden = false;
    /* החלון נשאר רגע כדי שאפשר יהיה לקרוא את האישור. המאזין
     * על התשובה יסיר את הקריאה מהרשימה בין כה ובין כך; השעון
     * קיים למקרה שהמאזין אינו מגיע — לא משאירים אדם נעול מול חלון. */
    if (owner.doneTimer) clearTimeout(owner.doneTimer);
    owner.doneTimer = setTimeout(function () {
      owner.doneTimer = null;
      if (activeOwner !== owner || owner.disposed) return;
      w.classList.remove('on');
    }, 1800);
  }

  function answer(which, why) {
    if (activeOwner !== owner || owner.disposed || sending) return;
    lock(true);
    if (which === 'coming') yes.textContent = 'שולח…';
    else send.textContent = 'שולח…';
    e.style.display = 'none';
    ackCallout(db, sid, id, uid, o.name || '', which, why)
      .then(function () {
        if (activeOwner !== owner || owner.disposed) return;
        succeed(which);
      })
      .catch(function (err) {
        if (activeOwner !== owner || owner.disposed) return;
        lock(false);
        yes.textContent = 'מגיע';
        send.textContent = 'שלח דחייה';
        logError('callout answer', err);
        // המשתמש רואה עברית. הקוד הטכני הלך ל-console.
        e.textContent = 'התשובה לא נשמרה. ' + errorText(err);
        e.style.display = 'block';
      });
  }

  yes.onclick = function () { answer('coming', ''); };
  no.onclick  = function () {
    if (sending) return;
    btns.hidden = true;
    reasonWrap.hidden = false;
    e.style.display = 'none';
    renderReasons();
    updateSend();
  };
  back.onclick = function () {
    if (sending) return;
    releaseKeyboardWatch();
    chosen = null;
    reason.value = ''; reason.hidden = true;
    reasonWrap.hidden = true;
    btns.hidden = false;
    e.style.display = 'none';
  };
  send.onclick = function () {
    const why = reasonText();
    if (!why) { updateSend(); return; }
    answer('no', why);
  };
  reason.oninput = function () { updateSend(); };

  w.classList.add('on');
  // הצפייה אינה תשובה ולכן אינה סוגרת או מסתירה את הקריאה.
  // אם הכתיבה נכשלת, הקריאה נשארת פתוחה והמשתמש עדיין יכול
  // לענות; מאזין עתידי ינסה שוב בעת ההצגה הבאה.
  markCalloutSeen(db, sid, id, uid).catch(function (err) {
    logError('callout seen', err);
  });
  alarm();
}
