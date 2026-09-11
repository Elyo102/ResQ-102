// מפת הרכב.
//
// אלדד: "כל רכב שמדווחים עליו תקלות ומכות יהיה סט של ארבע
// תמונות שהכבאי יצלם ויעלה — חזית, צד ימין, אחור, צד שמאל.
// ושם אפשר לדקור נקודה, להוסיף מלל תיאור, ולהעלות תמונה של
// המכה."
//
// ------------------------------------------------------------------
//  מה זה פותר
// ------------------------------------------------------------------
//
// "שריטה בדופן ימין" זה תיאור שכל אחד קורא אחרת. איפה בדופן?
// לפני הגלגל או אחריו? כמה גדולה? המשמרת הבאה מקבלת רכב עם
// שש שריטות ואין לה דרך לדעת אילו מהן כבר דווחו — אז או
// שמדווחים כפול, או שלא מדווחים בכלל.
//
// נקודה על תמונה עונה על כל זה במבט אחד.
//
// ------------------------------------------------------------------
//  ההחלטה המרכזית: קואורדינטות יחסיות
// ------------------------------------------------------------------
//
// הנקודה נשמרת כשני מספרים בין 0 ל-1 — חלק יחסי מרוחב התמונה
// ומגובהה, ולא פיקסלים.
//
// למה: אותה נקודה נצפית בטלפון ברוחב 390 ובמחשב ברוחב 1100.
// פיקסלים היו שולחים את הסימון למקום אחר בכל מכשיר, והדיווח
// היה הופך למטעה במקום למדויק — גרוע מלא לסמן בכלל.
//
// ------------------------------------------------------------------
//  ולמה זה לא אוסף חדש
// ------------------------------------------------------------------
//
// נקודה על המפה **היא** תקלה — יש לה מדווח, שעה, תיאור, צילום,
// חומרה שראש המשמרת קובע, והיא נסגרת או נמחקת באותם כללים.
// לכן היא נשמרת ב-faults עם שלושה שדות נוספים בלבד:
//
//   side   על איזו מארבע התמונות
//   x, y   איפה עליה
//
// אוסף נפרד היה מכריח לתחזק פעמיים את ההרשאות, את הדירוג ואת
// הלוג — ובסוף היו שתי אמיתות על אותו רכב.

export const SIDES = [
  { id: 'front', he: 'חזית',    short: 'חזית' },
  { id: 'right', he: 'צד ימין', short: 'ימין' },
  { id: 'rear',  he: 'אחור',    short: 'אחור' },
  { id: 'left',  he: 'צד שמאל', short: 'שמאל' }
];

export function sideHe(id) {
  const s = SIDES.filter(function (x) { return x.id === id; })[0];
  return s ? s.he : '';
}

export function isSide(id) {
  return SIDES.some(function (x) { return x.id === id; });
}

// מזהה קבוע ולא אקראי. כך העלאה חוזרת של אותו צד **מחליפה**
// את התמונה במקום ליצור עותק שני, ואי אפשר להגיע למצב של שתי
// תמונות חזית שאף אחד לא יודע איזו מהן הנכונה.
export function viewId(vehicleId, side) {
  return String(vehicleId || '') + '__' + String(side || '');
}

export function clamp01(n) {
  const v = Number(n);
  if (!isFinite(v)) return 0.5;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

// מיקום הלחיצה ביחס לתמונה, מעוגל לארבע ספרות. דיוק של
// מאית אחוז מספיק לסימון על תמונת רכב, וכל ספרה נוספת היא
// רק תווים במסמך.
export function pointAt(rect, clientX, clientY) {
  const w = rect.width || 1, h = rect.height || 1;
  const round = n => Math.round(n * 10000) / 10000;
  return { x: round(clamp01((clientX - rect.left) / w)),
           y: round(clamp01((clientY - rect.top) / h)) };
}

// ב-RTL הדפדפן אינו הופך תמונות, ולכן אין כאן היפוך. הנקודה
// נמדדת משמאל התמונה תמיד — אחרת סימון שנעשה בעברית היה
// מופיע במקום המשקף באנגלית.

export function hasPoint(f) {
  const v = f || {};
  return isSide(v.side) && typeof v.x === 'number' && typeof v.y === 'number';
}

// כל הנקודות של רכב אחד על צד אחד.
export function pointsOn(faults, vehicleId, side, opts) {
  const o = opts || {};
  return (faults || []).filter(function (f) {
    if (!hasPoint(f)) return false;
    if (f.vehicle_id !== vehicleId) return false;
    if (f.side !== side) return false;
    if (o.openOnly && f.status === 'fixed') return false;
    return true;
  });
}

// כמה נקודות פתוחות על כל צד — המספרים שעל הלשוניות.
//
// **פתוחות בלבד**, בכוונה. מספר שכולל תקלות שנסגרו רק גדל עם
// הזמן ולעולם לא יורד, ואז הוא מפסיק לומר משהו על מצב הרכב.
export function countBySide(faults, vehicleId) {
  const out = {};
  SIDES.forEach(function (s) { out[s.id] = 0; });
  (faults || []).forEach(function (f) {
    if (!hasPoint(f) || f.vehicle_id !== vehicleId) return;
    if (f.status === 'fixed') return;
    out[f.side] = (out[f.side] || 0) + 1;
  });
  return out;
}

// ------------------------------------------------------------------
//  שלמות הסט
// ------------------------------------------------------------------
//
// רכב עם שתי תמונות אינו "חצי מוכן" — הוא רכב שאי אפשר לדווח
// עליו על שני צדדים. לכן המסך אומר בדיוק מה חסר ולא רק
// "לא הושלם".

export function viewsOf(views, vehicleId) {
  const out = {};
  (views || []).forEach(function (v) {
    if (!v || v.vehicle_id !== vehicleId) return;
    if (!isSide(v.side)) return;
    out[v.side] = v;
  });
  return out;
}

export function missingSides(views, vehicleId) {
  const have = viewsOf(views, vehicleId);
  return SIDES.filter(function (s) { return !have[s.id]; }).map(function (s) { return s.id; });
}

export function coverage(views, vehicleId) {
  const n = SIDES.length - missingSides(views, vehicleId).length;
  return { done: n, total: SIDES.length,
           state: n === 0 ? 'none' : (n < SIDES.length ? 'partial' : 'full') };
}

export function missingHe(views, vehicleId) {
  const miss = missingSides(views, vehicleId);
  if (!miss.length) return '';
  return 'חסרות תמונות: ' + miss.map(sideHe).join(', ') + '.';
}

// סדר הצילום שהכבאי מקבל כהוראה. אותו סדר תמיד, כדי ששני
// אנשים שיצלמו את אותו רכב יפיקו סט שנראה אותו דבר.
export const SHOOT_ORDER = SIDES.map(function (s) { return s.id; });

export function nextToShoot(views, vehicleId) {
  const miss = missingSides(views, vehicleId);
  if (!miss.length) return '';
  return SHOOT_ORDER.filter(function (s) { return miss.indexOf(s) !== -1; })[0] || '';
}
