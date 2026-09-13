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
// התשובה נשמרת על מסמך הקריאה עצמו, בשדה acks, ולא באוסף
// נפרד. כך המפקד רואה את כל התשובות בקריאה אחת, בזמן אמת,
// בלי לשאול את השרת על כל אדם בנפרד.

import { collection, query, where, orderBy, limit, onSnapshot,
         doc, updateDoc, FieldPath }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// כמה זמן קריאה נחשבת חיה. אחרי זה היא לא תקפוץ יותר גם אם
// אף אחד לא סגר אותה — קריאה מלפני שמונה שעות היא היסטוריה,
// לא הזעקה.
export const CALLOUT_TTL_MS = 8 * 60 * 60 * 1000;

export const ACKS = [
  { id: 'coming', he: 'מגיע',    color: 'var(--good)' },
  { id: 'no',     he: 'לא זמין', color: 'var(--muted)' }
];

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
      '<div class="btns">' +
        '<button class="go" id="coYes">מגיע</button>' +
        '<button id="coNo">לא זמין</button>' +
      '</div>' +
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
}

export function ackCallout(db, sid, calloutId, uid, name, answer) {
  // Firestore treats dots in string keys as path separators.  A FieldPath
  // keeps every valid Firebase Auth UID, including a dotted UID, as one
  // literal key below `acks`, matching the flat `acks[uid]` reader.
  return updateDoc(
    doc(db, 'stations', sid, 'callouts', calloutId),
    new FieldPath('acks', uid),
    { resp: answer, name: name || '', at: new Date().toISOString() }
  );
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

let modeStop = null;
let modeResizeObserver = null;
let activeOwner = null;
let ownerSerial = 0;

function clearModeBarOffset() {
  if (modeResizeObserver) {
    try { modeResizeObserver.disconnect(); } catch (ignore) {}
    modeResizeObserver = null;
  }
  document.documentElement.style.removeProperty('--resq-mode-bar-height');
}

function trackModeBarHeight(el) {
  clearModeBarOffset();
  const update = function () {
    if (!el || !el.isConnected) return;
    const height = Math.ceil(el.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--resq-mode-bar-height', height + 'px');
  };
  update();
  if (typeof ResizeObserver === 'function') {
    modeResizeObserver = new ResizeObserver(update);
    modeResizeObserver.observe(el);
  }
}

function clearCalloutUi() {
  const w = document.getElementById('coWrap');
  if (!w) return;
  w.classList.remove('on');
  ['coText', 'coFrom', 'coMore', 'coErr'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });
  const err = document.getElementById('coErr');
  if (err) err.style.display = 'none';
  ['coYes', 'coNo'].forEach(function (id) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = false;
    btn.onclick = null;
  });
}

function modeBar(mode) {
  const on = mode === 'trial';
  let el = document.getElementById('modeBar');

  if (!on) {
    if (el) el.remove();
    document.body.classList.remove('has-mode-bar');
    clearModeBarOffset();
    return;
  }
  document.body.classList.add('has-mode-bar');
  if (el) {
    trackModeBarHeight(el);
    return;
  }

  el = document.createElement('div');
  el.id = 'modeBar';
  el.setAttribute('role', 'status');
  el.innerHTML = '<b>מצב ניסוי</b> · התראות ומיילים חסומים לכל התחנה. ' +
                 'שום דבר לא יוצא החוצה.';
  el.style.cssText = [
    'position:sticky', 'top:var(--resq-safe-top-override,env(safe-area-inset-top,0px))', 'z-index:950',
    'background:var(--warn-bg)', 'color:var(--warn)',
    'border-bottom:2px solid var(--warn)',
    'padding:9px 16px', 'box-sizing:border-box',
    'width:100%', 'align-self:stretch',
    'font-size:13px', 'font-weight:600',
    'line-height:1.6', 'direction:rtl', 'text-align:center',
    'font-family:"Segoe UI",Arial,sans-serif',
    'margin:0'
  ].join(';');
  document.body.insertBefore(el, document.body.firstChild);
  trackModeBarHeight(el);
}

export function watchMode(db, owner) {
  if (!db || !owner || owner.disposed) return;
  if (modeStop) {
    try { modeStop(); } catch (ignore) {}
    modeStop = null;
  }
  try {
    modeStop = onSnapshot(doc(db, 'config', 'mode'), function (d) {
      if (activeOwner !== owner || owner.disposed) return;
      const v = (d.exists() ? d.data() : {}) || {};
      modeBar(v.mode || 'live');
    }, function () {});
  } catch (e) {}
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
    dispose: null
  };
  owner.dispose = function () {
    if (owner.disposed) return;
    owner.disposed = true;
    try { owner.stop(); } catch (ignore) {}
    if (activeOwner !== owner) return;
    if (modeStop) {
      try { modeStop(); } catch (ignore) {}
      modeStop = null;
    }
    activeOwner = null;
    modeBar('live');
    clearCalloutUi();
  };
  activeOwner = owner;
  watchMode(db, owner);
  const o = opts || {};
  let shownId = '';

  const q = query(
    collection(db, 'stations', sid, 'callouts'),
    where('uids', 'array-contains', uid),
    orderBy('created_key', 'desc'),
    limit(5)
  );

  let stop = function () {};
  try {
    stop = onSnapshot(q, function (snap) {
      if (activeOwner !== owner || owner.disposed) return;
      const list = [];
      snap.forEach(function (d) {
        const v = d.data() || {};
        if (v.active === false) return;
        if (!fresh(v)) return;
        if (v.acks && v.acks[uid]) return;        // כבר עניתי
        list.push({ id: d.id, v: v });
      });

      if (!list.length) {
        const w = document.getElementById('coWrap');
        if (w) w.classList.remove('on');
        shownId = '';
        return;
      }

      const cur = list[0];
      if (cur.id === shownId) return;             // כבר על המסך
      shownId = cur.id;
      show(owner, db, sid, uid, cur.id, cur.v, o, list.length);
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

  const yes = document.getElementById('coYes');
  const no  = document.getElementById('coNo');

  function answer(which) {
    if (activeOwner !== owner || owner.disposed) return;
    yes.disabled = true; no.disabled = true;
    ackCallout(db, sid, id, uid, o.name || '', which)
      .then(function () {
        if (activeOwner !== owner || owner.disposed) return;
        yes.disabled = false; no.disabled = false;
        w.classList.remove('on');
        // shownId נשאר — ה-onSnapshot יסיר את הקריאה מהרשימה
        // ואם יש עוד אחת, היא תקפוץ מיד.
      })
      .catch(function (err) {
        if (activeOwner !== owner || owner.disposed) return;
        yes.disabled = false; no.disabled = false;
        e.textContent = 'התשובה לא נשמרה. ' +
          '(' + ((err && (err.code || err.message)) || 'שגיאה') + ') נסה שוב.';
        e.style.display = 'block';
      });
  }

  yes.onclick = function () { answer('coming'); };
  no.onclick  = function () { answer('no'); };

  w.classList.add('on');
  alarm();
}
