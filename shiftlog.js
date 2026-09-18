// =====================================================================
//  לוג המשמרת
// =====================================================================
//
//  אלדד: "כמו קבוצת ווטסאפ — לוג שרץ עם הודעות בזמן אמת בין
//  ראשי משמרות, סגנים ומפקדי צוותים. לוחם פשוט רק קורא."
//
//  **מה זה בא להחליף.** היום התיאום הזה קורה בוואטסאפ. שם
//  אין הרשאות, אין היסטוריה שאפשר לחפש בה, כל אחד יכול למחוק
//  הודעה אחרי שנאמרה, ומי שהצטרף לקבוצה אתמול לא רואה מה
//  סוכם לפני חודש. ובעיקר: זה נפרד מהמערכת שבה ההחלפה
//  באמת קורית, ולכן "סיכמנו בוואטסאפ" ו"מה שרשום במערכת"
//  הם שני דברים שונים.
//
//  **שלוש החלטות שנגזרות מזה:**
//
//  1. **קורא — כולם. כותב — רק הפיקוד.** כבאי רואה הכל, כי
//     לוג שהוא לא רואה אינו מודיע לו כלום. הוא לא כותב, כדי
//     שהערוץ יישאר ערוץ פיקודי ולא צ'אט של עשרים איש.
//
//  2. **אין עריכה ואין מחיקה.** תיקון נעשה בהודעה חדשה. זו
//     בדיוק הנקודה שבגללה זה לא נשאר בוואטסאפ.
//
//  3. **הודעות מערכת באותו פיד.** "אלדד לקח את המשמרת של
//     רמי ב-12.9" נכתב אוטומטית, ולכן הלוג הוא היסטוריה
//     שלמה ולא רק שיחה. הן נכתבות **בשרת בלבד** — לקוח
//     שמסמן הודעה שלו כ"מערכת" מתחזה למקור שאיש לא מפקפק בו,
//     וכללי האבטחה חוסמים את זה.

export const MAX_TEXT = 2000;

// ---------------------------------------------------------------
//  כתיבה
// ---------------------------------------------------------------

export function validateMessage(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return 'ההודעה ריקה.';
  if (t.length > MAX_TEXT) {
    return 'ההודעה ארוכה מדי — ' + t.length + ' תווים מתוך ' + MAX_TEXT + '.';
  }
  return '';
}

// me = { uid, full_name, role, crew, vehicle }
export function messageDoc(text, me, nowIso) {
  const m = me || {};
  return {
    text: String(text || '').trim(),
    kind: 'chat',
    by_uid: m.uid || '',
    by_name: m.full_name || '',
    by_role: m.role || '',
    by_crew: m.crew || '',
    // הרכב הוא **תצוגה בלבד**. אלדד הגדיר שהצוות נקבע גם לפי
    // תפקיד וגם לפי רכב, אבל הסמכות היחידה של מפקד צוות היא
    // לכתוב — והיא אינה תלויה בצוות. לכן זה יושב כאן כטקסט
    // ולא ככלל הרשאה.
    by_vehicle: m.vehicle || '',
    hidden: false,
    created_key: nowIso || new Date().toISOString()
  };
}

// ---------------------------------------------------------------
//  קריאה
// ---------------------------------------------------------------

// הודעות מוצגות מהישנה לחדשה, כמו בכל שיחה. מסמך מוסתר
// אינו מוצג — אבל הוא נשאר במסד, כי מחיקה שאי אפשר להוכיח
// שקרתה היא בדיוק מה שהופך לוג לחסר ערך.
export function visible(msgs) {
  return (msgs || [])
    .filter(function (m) { return m && m.hidden !== true; })
    .slice()
    .sort(function (a, b) {
      return String(a.created_key || '').localeCompare(String(b.created_key || ''));
    });
}

const HE_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

export function dayLabel(dayKey, today) {
  const t = today || new Date();
  const tk = isoDay(t);
  if (dayKey === tk) return 'היום';
  const y = new Date(t.getTime() - 86400000);
  if (dayKey === isoDay(y)) return 'אתמול';
  const p = String(dayKey || '').split('-');
  if (p.length !== 3) return String(dayKey || '');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return 'יום ' + HE_DAYS[d.getDay()] + ' · ' +
         Number(p[2]) + '.' + Number(p[1]) + '.' + p[0];
}

export function isoDay(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const a = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + a;
}

// קיבוץ לפי יום. בלי מפרידי ימים, שיחה של שבועיים נראית
// כמו רצף אחד ואי אפשר לדעת מתי נאמר מה.
export function groupByDay(msgs, today) {
  const out = [];
  let cur = null;
  visible(msgs).forEach(function (m) {
    const k = String(m.created_key || '').slice(0, 10);
    if (!cur || cur.dayKey !== k) {
      cur = { dayKey: k, label: dayLabel(k, today), items: [] };
      out.push(cur);
    }
    cur.items.push(m);
  });
  return out;
}

export function timeOf(msg) {
  return String((msg && msg.created_key) || '').slice(11, 16);
}

// ---------------------------------------------------------------
//  לא-נקראו
// ---------------------------------------------------------------
//
//  נשמר במכשיר ולא בשרת, במכוון. "מה קראתי" הוא נתון של
//  מכשיר אחד ולא של אדם: אם הוא יישמר בשרת, פתיחה במחשב
//  תסמן כנקרא גם את מה שלא נראה בטלפון. ובנוסף — כתיבה
//  לשרת בכל פתיחה של מסך היא עלות מיותרת על נתון שאיש
//  לא יסתכל עליו בדיעבד.
//
//  localStorage זורק בהקשרים מסוימים (חלון פרטי, דפדפן
//  שחוסם אחסון), ולכן כל גישה עטופה. בלי ערך שמור — הכל
//  ייחשב נקרא, כי להציג "47 חדשות" למי שרק התקין זה רעש.

const KEY = 'resq_shiftlog_read';

export function lastRead(sid) {
  try { return localStorage.getItem(KEY + '_' + sid) || ''; }
  catch (e) { return ''; }
}

export function markRead(sid, key) {
  try { localStorage.setItem(KEY + '_' + sid, String(key || '')); }
  catch (e) { /* אחסון חסום — אין מה לעשות, וזה לא שובר כלום */ }
}

export function unreadCount(msgs, since, myUid) {
  if (!since) return 0;
  return visible(msgs).filter(function (m) {
    if (myUid && m.by_uid === myUid) return false;   // מה שאני כתבתי קראתי
    return String(m.created_key || '') > String(since);
  }).length;
}

export function newestKey(msgs) {
  const v = visible(msgs);
  return v.length ? String(v[v.length - 1].created_key || '') : '';
}

// ---------------------------------------------------------------
//  הודעות מערכת
// ---------------------------------------------------------------
//
//  הטקסטים יושבים כאן ולא בשרת, כדי שאפשר יהיה לבדוק אותם
//  בלי להריץ פונקציות ענן. השרת מייבא את אותו קובץ.

export function swapSystemText(status, d) {
  const s = d || {};
  const from = s.from_name || 'כבאי';
  const to   = s.to_name   || 'כבאי';
  const dt   = function (k) {
    const p = String(k || '').split('-');
    return p.length === 3 ? Number(p[2]) + '.' + Number(p[1]) : String(k || '');
  };

  switch (status) {
    case 'open':
      return from + ' פרסם בקשת החלפה ל-' + dt(s.from_date) + '.';
    case 'peer':
      return from + ' ביקש להחליף עם ' + to + ' · ' +
             dt(s.from_date) + ' מול ' + dt(s.to_date) + '.';
    case 'cmd_from':
      return to + ' הסכים להחלפה עם ' + from + '. ממתין למפקדים.';
    case 'cmd_to':
      return 'מפקד המשמרת של ' + from + ' אישר. ממתין למפקד של ' + to + '.';
    case 'approved':
      return '✅ ההחלפה אושרה: ' + from + ' ↔ ' + to + ' · ' +
             dt(s.from_date) + ' מול ' + dt(s.to_date) + '.';
    case 'rejected':
      return '❌ ההחלפה בין ' + from + ' ל-' + to + ' נדחתה.';
    case 'cancelled':
      return 'הבקשה של ' + from + ' בוטלה.';
    default:
      return '';
  }
}
