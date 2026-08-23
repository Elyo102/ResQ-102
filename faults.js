// תקלות וחפיפת משמרת.
//
// שני דברים שנראים שונים ומתנהגים אותו דבר: תקלה שנפתחה על
// רכב, והערה שכבאי משאיר למשמרת הבאה. שניהם "משהו שקרה
// במשמרת שלי שהבא אחריי צריך לדעת עליו", שניהם צריכים שם
// מדווח ושעה, ולשניהם מותר לצרף צילום.
//
// לכן זה אוסף אחד ולא שניים. דף החפיפה אינו מודול נפרד — הוא
// תצוגה של אותו אוסף, מסוננת ליום ולמשמרת.
//
// ------------------------------------------------------------------
//  צילומים
// ------------------------------------------------------------------
//
// התמונה מוקטנת בדפדפן ונשמרת כמסמך נפרד תחת התקלה, ולא
// ב-Firebase Storage.
//
// למה: Storage הוא משטח חדש לגמרי — חוקים משלו, הגדרת CORS,
// ושלב פריסה נוסף שאלדד מריץ ידנית. תמונת תיעוד של תקלה אינה
// צריכה רזולוציה מלאה, ותמונה מוקטנת ל-1280 פיקסל יושבת
// בנוחות במסמך Firestore.
//
// מתי זה יפסיק להספיק: אם יצטברו מאות תקלות עם כמה תמונות
// לכל אחת, או אם יידרש וידאו. אז עוברים ל-Storage, וההעברה
// היא של מודול אחד.

export const FAULT_KINDS = [
  { id: 'vehicle',  he: 'תקלת רכב',        needsVehicle: true,  group: 'fault' },
  { id: 'gear',     he: 'תקלת ציוד',       needsVehicle: false, group: 'fault' },
  { id: 'building', he: 'תקלת מבנה',       needsVehicle: false, group: 'fault' },
  { id: 'task_st',  he: 'משימת תחזוקת תחנה', needsVehicle: false, group: 'task' },
  { id: 'task_eq',  he: 'משימת תחזוקת ציוד', needsVehicle: false, group: 'task' },
  { id: 'note',     he: 'מסר / הערכת מצב', needsVehicle: false, group: 'note' }
];

export function groupOf(id) {
  const k = FAULT_KINDS.filter(function (x) { return x.id === id; })[0];
  return k ? k.group : 'fault';
}
export function isTask(f)  { return groupOf((f || {}).kind) === 'task'; }
export function isNote(f)  { return groupOf((f || {}).kind) === 'note'; }
export function isFault(f) { return groupOf((f || {}).kind) === 'fault'; }

export function kindHe(id) {
  const k = FAULT_KINDS.filter(function (x) { return x.id === id; })[0];
  return k ? k.he : String(id || '');
}
export function needsVehicle(id) {
  const k = FAULT_KINDS.filter(function (x) { return x.id === id; })[0];
  return !!(k && k.needsVehicle);
}

// חומרה. הסדר כאן הוא סדר הדחיפות, ומשמש למיון.
export const SEVERITIES = [
  { id: 'blocking', he: 'משבית',  color: '#ef5350', rank: 0,
    note: 'הרכב או הציוד לא כשיר לשימוש' },
  { id: 'limiting', he: 'מגביל',  color: '#e0a23c', rank: 1,
    note: 'אפשר להשתמש, עם מגבלה' },
  { id: 'minor',    he: 'קלה',    color: '#4d94ff', rank: 2,
    note: 'לתיעוד ולטיפול בהמשך' }
];

export function sevHe(id) {
  const s = SEVERITIES.filter(function (x) { return x.id === id; })[0];
  return s ? s.he : '';
}
export function sevColor(id) {
  const s = SEVERITIES.filter(function (x) { return x.id === id; })[0];
  return s ? s.color : '#9aa0a6';
}
export function sevRank(id) {
  const s = SEVERITIES.filter(function (x) { return x.id === id; })[0];
  return s ? s.rank : 9;
}

export const FAULT_STATES = [
  { id: 'open',      he: 'פתוחה',     color: '#ef5350' },
  { id: 'in_repair', he: 'בטיפול',    color: '#e0a23c' },
  { id: 'fixed',     he: 'טופלה',     color: '#66bb6a' }
];

export function stateHe(id) {
  const s = FAULT_STATES.filter(function (x) { return x.id === id; })[0];
  return s ? s.he : String(id || '');
}
export function stateColor(id) {
  const s = FAULT_STATES.filter(function (x) { return x.id === id; })[0];
  return s ? s.color : '#9aa0a6';
}

export function isOpen(f) {
  return (f || {}).status !== 'fixed';
}

// ------------------------------------------------------------------
//  רכבים
// ------------------------------------------------------------------
//
// שני סוגים, ושניהם חיים במקום אחר:
//
//   fire    רכבי כיבוי וחילוץ. מוגדרים בלוח הציוות, כי שם הם
//           נושאים משבצות ותפקידים
//   anchor  רכבי עיגון — רכבים קטנים למשימות לוגיסטיות. אין
//           להם משבצות בלוח, ולכן הם חיים באוסף vehicles
//
// אין כאן כפילות: כל רכב קיים במקום אחד בדיוק. המסך הזה רק
// מאחד את שתי הרשימות לצורך בחירה.

export const VEHICLE_KINDS = [
  { id: 'fire',   he: 'רכב מבצעי' },
  { id: 'anchor', he: 'רכב עיגון' }
];

export function mergeFleet(boardVehicles, anchorVehicles) {
  const out = [];
  (boardVehicles || []).forEach(function (v) {
    if (!v || !v.id) return;
    out.push({ id: v.id, name: v.name || v.id, kind: 'fire',
               role: v.role || '', managed: false });
  });
  (anchorVehicles || []).forEach(function (v) {
    if (!v || !v.id) return;
    out.push({ id: v.id, name: v.name || v.id, kind: 'anchor',
               role: v.plate || '', managed: true });
  });
  return out;
}

// מצב רכב נגזר מהתקלות הפתוחות שלו, ולא נשמר כשדה.
//
// שדה מצב שנשמר בנפרד מתיישן: מישהו סוגר תקלה ושוכח לעדכן,
// והרכב נשאר "משבית" על המסך שבועיים אחרי שתוקן. כאן אין מה
// לשכוח.
export function vehicleState(faults, vehicleId) {
  const open = (faults || []).filter(function (f) {
    return f && isOpen(f) && f.vehicle_id === vehicleId;
  });
  if (!open.length) return { id: 'ok', he: 'תקין', color: '#66bb6a', faults: [] };

  const worst = open.reduce(function (a, f) {
    return sevRank(f.severity) < sevRank(a.severity) ? f : a;
  }, open[0]);

  if (worst.severity === 'blocking') {
    return { id: 'blocked', he: 'משבית', color: '#ef5350', faults: open };
  }
  if (worst.severity === 'limiting') {
    return { id: 'limited', he: 'מגביל', color: '#e0a23c', faults: open };
  }
  return { id: 'minor', he: 'תקלה קלה', color: '#4d94ff', faults: open };
}

// ------------------------------------------------------------------
//  מיון ותצוגה
// ------------------------------------------------------------------

// פתוחות קודם, ובתוכן החמורות קודם, ובתוכן החדשות קודם.
export function sortFaults(list) {
  return (list || []).slice().sort(function (a, b) {
    const ao = isOpen(a) ? 0 : 1, bo = isOpen(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ar = sevRank(a.severity), br = sevRank(b.severity);
    if (ar !== br) return ar - br;
    return String(b.created_key || '').localeCompare(String(a.created_key || ''));
  });
}

export function toKey(d) {
  if (typeof d === 'string') return d;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const a = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + a;
}

export function dmy(key) {
  const p = String(key || '').split('-');
  return p.length === 3 ? Number(p[2]) + '.' + Number(p[1]) + '.' + p[0] : String(key || '');
}

// "מי דיווח, מתי" — השורה שאלדד ביקש שתופיע לצד כל תקלה.
// התאריך והשעה נלקחים מ-created_key, שהוא ISO מלא.
export function reportedLine(f) {
  const v = f || {};
  const iso = String(v.created_key || '');
  const day = iso.slice(0, 10), tm = iso.slice(11, 16);
  const who = v.by_name || 'לא ידוע';
  if (!day) return who;
  return who + ' · ' + dmy(day) + (tm ? ' ' + tm : '');
}

// ------------------------------------------------------------------
//  דף החפיפה
// ------------------------------------------------------------------
//
// מה שנפתח במשמרת הזו, ומה שעדיין פתוח ממשמרות קודמות. שני
// הדברים, כי הבא במשמרת צריך לדעת גם מה קרה אתמול וגם מה עוד
// לא טופל משבוע שעבר.

export function handoverFor(faults, crew, dateKey) {
  const all = faults || [];
  const mine = all.filter(function (f) {
    return f && f.crew === crew && String(f.date || '') === String(dateKey);
  });
  const carried = all.filter(function (f) {
    if (!f || !isOpen(f)) return false;
    if (f.crew === crew && String(f.date || '') === String(dateKey)) return false;
    return true;
  });
  return { today: sortFaults(mine), carried: sortFaults(carried) };
}

// דף החפיפה, מחולק לפי מה שהמשמרת הנכנסת צריכה לדעת.
//
// החלוקה אינה קישוט: מפקד שנכנס למשמרת שואל ארבע שאלות
// שונות — מה שבור ברכבים, מה שבור בציוד, מה עלי לעשות, ומה
// זמין לי — ותשובה אחת מעורבבת מכריחה אותו למיין בעצמו
// בשש בבוקר.
export function handoverBoard(faults, fleet) {
  const open = (faults || []).filter(isOpen);

  const veh = sortFaults(open.filter(function (f) { return f.kind === 'vehicle'; }));
  const gear = sortFaults(open.filter(function (f) {
    return f.kind === 'gear' || f.kind === 'building';
  }));
  const tasks = sortFaults(open.filter(isTask));
  const notes = sortFaults(open.filter(isNote));

  // ציוד ורכב שנמצאים בתיקון — תת-קבוצה, כי "בטיפול" זו
  // תשובה אחרת מ"שבור ואף אחד לא נגע".
  const inRepair = sortFaults(open.filter(function (f) {
    return f.status === 'in_repair';
  }));

  const anchors = (fleet || []).filter(function (v) { return v.kind === 'anchor'; })
    .map(function (v) {
      const st = vehicleState(faults, v.id);
      return { id: v.id, name: v.name, plate: v.role || '',
               state: st.id, he: st.he, color: st.color,
               available: st.id === 'ok' || st.id === 'minor' };
    });

  return { veh, gear, tasks, notes, inRepair, anchors,
           blocked: veh.filter(function (f) { return f.severity === 'blocking'; }) };
}

// דוח נזק לרכב: כל מה שאי פעם נפתח עליו, פתוח וסגור.
export function vehicleReport(faults, vehicleId) {
  return sortFaults((faults || []).filter(function (f) {
    return f && f.vehicle_id === vehicleId;
  }));
}

// ------------------------------------------------------------------
//  מסירת אחריות
// ------------------------------------------------------------------
//
// זו החתימה. אלדד הגדיר: מפקד משמרת או סגנו מאשר, ונרשם בלוג
// שהחפיפה והאחריות עברו ממפקד אחד לשני בשעה מסוימת.
//
// לכן שני דברים לא ניתנים לשינוי אחרי האישור: מי מסר, ומתי.
// רשומה שאפשר לערוך בדיעבד אינה חתימה.

export function handoverId(crew, dateKey) {
  return String(crew || '') + '_' + String(dateKey || '');
}

export function acceptedLine(h) {
  const v = h || {};
  if (!v.accepted_key) return '';
  const t = String(v.accepted_key).slice(11, 16);
  const d = dmy(String(v.accepted_key).slice(0, 10));
  return 'החפיפה והאחריות הועברו מ' + (v.from_name || '—') +
         ' ל' + (v.to_name || '—') + ' ב-' + d +
         (t ? ' בשעה ' + t : '') + '.';
}

// ------------------------------------------------------------------
//  הקטנת תמונה
// ------------------------------------------------------------------
//
// מקטין לרוחב מרבי, ואז מוריד איכות בצעדים עד שהתוצאה נכנסת
// למגבלת המסמך. עדיף תמונה קצת פחות חדה מאשר שמירה שנכשלת
// עם הודעה שאיש לא מבין.

export const MAX_EDGE  = 1280;
export const MAX_BYTES = 600 * 1024;   // מתחת למגבלת המסמך של Firestore

export function shrinkImage(file, maxEdge, maxBytes) {
  const edge = maxEdge || MAX_EDGE;
  const cap  = maxBytes || MAX_BYTES;

  return new Promise(function (resolve, reject) {
    if (!file || !/^image\//.test(file.type || '')) {
      reject(new Error('זה לא קובץ תמונה.'));
      return;
    }
    const fr = new FileReader();
    fr.onerror = function () { reject(new Error('לא הצלחתי לקרוא את הקובץ.')); };
    fr.onload = function () {
      const img = new Image();
      img.onerror = function () { reject(new Error('הקובץ אינו תמונה תקינה.')); };
      img.onload = function () {
        let w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { reject(new Error('לא הצלחתי לקרוא את גודל התמונה.')); return; }
        if (w > edge || h > edge) {
          const s = edge / Math.max(w, h);
          w = Math.round(w * s); h = Math.round(h * s);
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) { reject(new Error('הדפדפן לא תומך בעיבוד תמונה.')); return; }
        ctx.drawImage(img, 0, 0, w, h);

        let q = 0.72, url = '';
        for (let i = 0; i < 6; i++) {
          url = c.toDataURL('image/jpeg', q);
          if (url.length <= cap) break;
          q -= 0.1;
          if (q < 0.3) break;
        }
        if (url.length > cap) {
          reject(new Error('התמונה גדולה מדי גם אחרי הקטנה. נסה צילום אחר.'));
          return;
        }
        resolve({ data: url, w: w, h: h, bytes: url.length });
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
