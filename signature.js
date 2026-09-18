// =====================================================================
//  חתימה שמורה
// =====================================================================
//
//  כל אדם מצייר או מעלה את חתימתו פעם אחת, ומכאן והלאה מאשר
//  בלחיצה. כבאי שחותם על דוח שעות בסוף כל חודש, על כל טופס
//  חופשה ועל כל מסירת אחריות, לא יצייר באצבע חמש-עשרה פעמים
//  בשנה — הוא יפסיק לחתום, והמסמכים יישארו לא חתומים.
//
//  מה שנשמר במסמך החתום הוא **עותק** של התמונה, לא הפניה
//  לחתימה השמורה. זו נקודה משפטית ולא טכנית: אם אדם יחליף
//  את חתימתו מחר, מסמך שנחתם אתמול חייב להמשיך להראות את
//  מה שנחתם בפועל. הפניה הייתה משנה מסמכים בדיעבד.
//
//  יחד עם התמונה נשמרים תמיד השם, מספר העובד והשעה. חתימה
//  בלי מי ומתי אינה שווה דבר.

import {
  doc, getDoc, setDoc, deleteDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// גבול הגודל. מסמך ב-Firestore מוגבל למגה, והחתימה יושבת בתוכו
// יחד עם שאר השדות. 400KB הוא גם המספר שבכללי האבטחה.
const MAX_BYTES = 400000;

// ---------------------------------------------------------------
//  קריאה ושמירה
// ---------------------------------------------------------------

export async function loadSignature(db, sid, uid) {
  try {
    const snap = await getDoc(doc(db, `stations/${sid}/signatures/${uid}`));
    return snap.exists() ? (snap.data() || null) : null;
  } catch (e) {
    console.warn('טעינת חתימה נכשלה: ' + (e && e.message));
    return null;
  }
}

export async function saveSignature(db, sid, uid, image, meta) {
  if (!image || image.length < 100) throw new Error('החתימה ריקה.');
  if (image.length > MAX_BYTES) {
    throw new Error('החתימה כבדה מדי. נסה תמונה קטנה יותר או צייר אותה במקום.');
  }
  await setDoc(doc(db, `stations/${sid}/signatures/${uid}`), {
    image: image,
    full_name: (meta && meta.full_name) || '',
    emp_number: (meta && meta.emp_number) || '',
    saved_at: serverTimestamp()
  });
}

export async function clearSignature(db, sid, uid) {
  await deleteDoc(doc(db, `stations/${sid}/signatures/${uid}`));
}

// ---------------------------------------------------------------
//  קנבס ציור
// ---------------------------------------------------------------
//
// עובד באצבע ובעכבר. touch-action:none חיוני — בלעדיו הדפדפן
// בטלפון מפרש את הציור כגלילה, והחתימה יוצאת קו אחד קטוע.

export function attachPad(canvas, opts) {
  const o = opts || {};
  const ctx = canvas.getContext('2d');
  let drawing = false, dirty = false;

  function size() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.round(r.width  * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.scale(dpr, dpr);
    // רקע לבן מפורש. קנבס שקוף יוצא שחור-על-שחור כשהוא נשמר
    // כ-PNG ומוצג על רקע כהה — וזה בדיוק מה שקרה כאן פעם.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, r.width, r.height);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111111';
  }
  size();

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const t = (e.touches && e.touches[0]) || e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };

  const start = (e) => {
    e.preventDefault();
    drawing = true; dirty = true;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
    if (o.onChange) o.onChange(true);
  };
  const move = (e) => {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.lineTo(p.x, p.y); ctx.stroke();
  };
  const end = () => { drawing = false; };

  canvas.style.touchAction = 'none';
  ['mousedown', 'touchstart'].forEach(n => canvas.addEventListener(n, start, { passive: false }));
  ['mousemove', 'touchmove'].forEach(n => canvas.addEventListener(n, move,  { passive: false }));
  ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(n => canvas.addEventListener(n, end));

  return {
    clear() { size(); dirty = false; if (o.onChange) o.onChange(false); },
    isEmpty() { return !dirty; },
    toImage() { return dirty ? canvas.toDataURL('image/png') : ''; },

    // הצגת חתימה קיימת בתוך הקנבס, כדי שאפשר יהיה לראות אותה
    // לפני שמחליפים.
    load(dataUrl) {
      return new Promise((res) => {
        const img = new Image();
        img.onload = () => {
          size();
          const r = canvas.getBoundingClientRect();
          const s = Math.min(r.width / img.width, r.height / img.height);
          ctx.drawImage(img, (r.width - img.width * s) / 2,
                             (r.height - img.height * s) / 2,
                             img.width * s, img.height * s);
          dirty = true;
          if (o.onChange) o.onChange(true);
          res(true);
        };
        img.onerror = () => res(false);
        img.src = dataUrl;
      });
    }
  };
}

// ---------------------------------------------------------------
//  העלאת תמונה
// ---------------------------------------------------------------
//
// מי שיש לו חתימה סרוקה על נייר יעלה אותה. התמונה מוקטנת
// ומומרת ל-PNG לבן, כדי שגם צילום של 4 מגה מהטלפון ייכנס
// למגבלה בלי שהמשתמש יצטרך להבין למה.

export function readImageFile(file, maxW) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('לא נבחר קובץ.'));
    if (!/^image\//.test(file.type)) {
      return reject(new Error('צריך קובץ תמונה — PNG או JPG.'));
    }
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('קריאת הקובץ נכשלה.'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('הקובץ אינו תמונה תקינה.'));
      img.onload = () => {
        const W = maxW || 600;
        const s = Math.min(1, W / img.width);
        const c = document.createElement('canvas');
        c.width  = Math.round(img.width  * s);
        c.height = Math.round(img.height * s);
        const x = c.getContext('2d');
        x.fillStyle = '#ffffff';
        x.fillRect(0, 0, c.width, c.height);
        x.drawImage(img, 0, 0, c.width, c.height);

        let out = c.toDataURL('image/png');
        // צילום מהטלפון יכול לצאת כבד גם אחרי הקטנה. יורדים
        // ל-JPEG ומורידים איכות עד שנכנסים, במקום לזרוק שגיאה
        // שהמשתמש לא יודע מה לעשות איתה.
        let q = 0.85;
        while (out.length > MAX_BYTES && q > 0.3) {
          out = c.toDataURL('image/jpeg', q);
          q -= 0.15;
        }
        if (out.length > MAX_BYTES) {
          return reject(new Error('התמונה כבדה מדי גם אחרי הקטנה. צלם מקרוב יותר, או צייר במקום.'));
        }
        resolve(out);
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

// signatureRecord עברה ל-signflow.js: היא לוגיקה טהורה בלי שום
// תלות בדפדפן, ולכן שם אפשר לבדוק אותה. מיוצאת מחדש כאן, כדי
// שמסך שמייבא רק את signature.js לא יישבר.
export { signatureRecord } from './signflow.js';
