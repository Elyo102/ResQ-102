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
  { id: 'damage',   he: 'פגיעה ברכב',      needsVehicle: true,  group: 'damage' },
  { id: 'gear',     he: 'תקלת ציוד',       needsVehicle: true,  group: 'fault' },
  { id: 'building', he: 'תקלת בינוי ותחזוקה', needsVehicle: false, group: 'fault',
    titlePlaceholder: 'לדוגמה: נזילה, תקלה בחשמל, דלת או מיזוג',
    descPlaceholder: 'איפה התקלה, מה בדיוק קרה, מתי התגלתה ומה כבר נעשה' },
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
export function isDamage(f) { return groupOf((f || {}).kind) === 'damage'; }

// ------------------------------------------------------------------
//  פגיעות ומכות ברכב
// ------------------------------------------------------------------
//
// פגיעה אינה תקלה, ולכן היא אינה נסגרת — היא נמחקת או שהיא
// קיימת. אלדד: "פגיעות ומכות ברכב לעולם לא נמחקות, תמיד יש
// תיעוד, אלא אם תוקנה במוסך המכה ואז ניתן להסיר באישור ראש
// משמרת."
//
// ההיגיון: מכה שתוקנה בפועל כבר לא קיימת על הרכב, ולכן רישום
// שלה מטעה את מי שמקבל את הרכב אחריך. מכה שלא תוקנה נשארת
// לנצח, כי היא עדיין שם.
//
// ההשלכה שחשוב להבין: המחיקה היא סופית. אין ארכיון, ואין
// "לבטל". לכן היא דורשת אישור של ראש משמרת ולא של כל אחד.

export const DAMAGE_DELETE_WHY =
  'פגיעה נמחקת רק אחרי תיקון בפועל במוסך. המחיקה סופית ואין ' +
  'לה ארכיון — מכה שתוקנה כבר לא קיימת על הרכב, ורישום שלה ' +
  'מטעה את מי שמקבל אותו אחריך.';

export function damagesOf(faults, vehicleId) {
  return sortFaults((faults || []).filter(function (f) {
    return isDamage(f) && f.vehicle_id === vehicleId && isOpen(f);
  }));
}

export function hasDamage(faults, vehicleId) {
  return damagesOf(faults, vehicleId).length > 0;
}

export function kindHe(id) {
  const k = FAULT_KINDS.filter(function (x) { return x.id === id; })[0];
  return k ? k.he : String(id || '');
}
export function needsVehicle(id) {
  const k = FAULT_KINDS.filter(function (x) { return x.id === id; })[0];
  return !!(k && k.needsVehicle);
}
export function faultKind(id) {
  return FAULT_KINDS.filter(function (x) { return x.id === id; })[0] || null;
}

// חומרה. הסדר כאן הוא סדר הדחיפות, ומשמש למיון.
//
// **את החומרה קובע ראש המשמרת או סגנו, לא המדווח.**
//
// הכבאי מתאר מה ראה ומצלם. הוא לא נשאל כמה זה חמור, כי זו
// החלטה מבצעית שאינה שלו: מי שיסמן "קלה" על משהו חמור יקבור
// אותו בתחתית הרשימה, ומי שיסמן "משבית" יוציא רכב מהכוננות.
//
// עד שראש המשמרת נוגע, התקלה נמצאת ב-'unset' — ממתינה
// להערכה, ומוצגת ראשונה כדי שלא תישכח.
export const SEVERITIES = [
  { id: 'blocking', he: 'משבית',  color: 'var(--bad-txt)', rank: 1,
    note: 'הרכב, הציוד או המקום אינם בטוחים או כשירים לשימוש', staffOnly: true },
  { id: 'limiting', he: 'מגביל',  color: 'var(--warn)', rank: 2,
    note: 'אפשר להשתמש, עם מגבלה', staffOnly: true },
  { id: 'minor',    he: 'קלה',    color: 'var(--note)', rank: 3,
    note: 'לתיעוד ולטיפול בהמשך', staffOnly: true }
];

// לא חומרה — היעדר החלטה. יושבת בראש המיון בכוונה.
export const UNSET = { id: 'unset', he: 'ממתינה להערכה',
                       color: 'var(--pick)', rank: 0,
                       note: 'ראש המשמרת עוד לא קבע חומרה' };

export function allSeverities() {
  return [UNSET].concat(SEVERITIES);
}
export function needsGrading(f) {
  const v = (f || {}).severity;
  return !v || v === 'unset';
}

export function sevHe(id) {
  const s = allSeverities().filter(function (x) { return x.id === id; })[0];
  return s ? s.he : UNSET.he;
}
export function sevColor(id) {
  const s = allSeverities().filter(function (x) { return x.id === id; })[0];
  return s ? s.color : UNSET.color;
}
// sevColor() נועד לטקסט חזית - --bad-txt לחומרה 'blocking' (בטוח בשתי
// הערכות; זו הסיבה ש-42H.20 הפנה אליו). כמה קריאות ב-vehicle.html
// משתמשות באותו ערך כרקע רווי במקום זאת (עיגול המספר על כרטיס תקלה,
// רקע כלי הרכב עצמו) - שם --bad-txt נכשל במצב כהה (ef5350 עם טקסט
// לבן, 3.49:1). sevBgColor() הוא הגרסה לרקע: אותם צבעים, חוץ מ-
// 'blocking' שמקבל בחזרה את --bad הגולמי, הבטוח כרקע בשתי הערכות.
export function sevBgColor(id) {
  const c = sevColor(id);
  return c === 'var(--bad-txt)' ? 'var(--bad)' : c;
}
export function sevRank(id) {
  const s = allSeverities().filter(function (x) { return x.id === id; })[0];
  return s ? s.rank : UNSET.rank;
}

export const FAULT_STATES = [
  { id: 'open',      he: 'פתוחה',     color: 'var(--bad-txt)' },
  { id: 'in_repair', he: 'בטיפול',    color: 'var(--warn)' },
  { id: 'fixed',     he: 'טופלה',     color: 'var(--good)' }
];

export function stateHe(id) {
  const s = FAULT_STATES.filter(function (x) { return x.id === id; })[0];
  return s ? s.he : String(id || '');
}
export function stateColor(id) {
  const s = FAULT_STATES.filter(function (x) { return x.id === id; })[0];
  return s ? s.color : 'var(--muted)';
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

// רכב מושבת אינו בצי, והסינון יושב **כאן ולא בכל מסך בנפרד**:
// שלושה מסכים קוראים את אותו מיזוג, וסינון משוכפל הוא בדיוק הדרך
// שבה רכב שהוסר נעלם במסך אחד ונשאר במסך השני.
//
// רכב בלי השדה `active` הוא פעיל — כל הרכבים שנכתבו לפני שהשדה
// היה קיים. רק `active === false` מסיר מהצי.
//
// `managed` אומר „הרשומה הזאת נערכת ישירות": רכב עיגון הוא מסמך
// משלו, רכב מבצעי הוא אובייקט בתוך מסמך הלוח. שניהם ניתנים
// לעריכה במצב הצי — אבל לא באותה כתיבה.
export function mergeFleet(boardVehicles, anchorVehicles, options = {}) {
  const out = [];
  // Operational pickers remain active-only. History readers explicitly opt in;
  // including an archived record never reactivates it or writes the source.
  const history = options.includeInactive === true;
  const live = function (v) { return !!v && !!v.id && (history || v.active !== false); };
  const state = v => history ? { active:v.active !== false } : {};
  (boardVehicles || []).forEach(function (v) {
    if (!live(v)) return;
    out.push(Object.assign({ id: v.id, name: v.name || v.id, kind: 'fire',
               role: v.role || '', plate: v.plate || '', managed: false }, state(v)));
  });
  (anchorVehicles || []).forEach(function (v) {
    if (!live(v)) return;
    out.push(Object.assign({ id: v.id, name: v.name || v.id, kind: 'anchor',
               role: v.plate || '', plate: v.plate || '', managed: true }, state(v)));
  });
  return out;
}

// מצב רכב נגזר מהתקלות הפתוחות שלו, ולא נשמר כשדה.
//
// שדה מצב שנשמר בנפרד מתיישן: מישהו סוגר תקלה ושוכח לעדכן,
// והרכב נשאר "משבית" על המסך שבועיים אחרי שתוקן. כאן אין מה
// לשכוח.
// כשירות הרכב נגזרת מתקלות בלבד. פגיעה היא חיווי נפרד:
// שריטה בדופן אינה מונעת מהרכב לצאת, ואם היא הייתה נספרת
// כאן, "משבית" ו"יש מכה" היו נראים אותו דבר.
export function vehicleState(faults, vehicleId) {
  const open = (faults || []).filter(function (f) {
    return f && isOpen(f) && f.vehicle_id === vehicleId && !isDamage(f);
  });
  if (!open.length) return { id: 'ok', he: 'תקין', color: 'var(--good)', faults: [] };

  const worst = open.reduce(function (a, f) {
    return sevRank(f.severity) < sevRank(a.severity) ? f : a;
  }, open[0]);

  if (needsGrading(worst)) {
    return { id: 'ungraded', he: 'ממתינה להערכה', color: 'var(--pick)',
             faults: open };
  }
  if (worst.severity === 'blocking') {
    return { id: 'blocked', he: 'משבית', color: 'var(--bad-txt)', faults: open };
  }
  if (worst.severity === 'limiting') {
    return { id: 'limited', he: 'מגביל', color: 'var(--warn)', faults: open };
  }
  return { id: 'minor', he: 'תקלה קלה', color: 'var(--note)', faults: open };
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
    return compareReportTime(a, b);
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

// Firestore's server timestamp wins over the old client clock. Legacy records
// keep their ISO key as fallback; newly created reports always have both.
export function reportTime(f) {
  const v = f || {};
  const stamp = v.created_at;
  if (stamp && typeof stamp.toDate === 'function') {
    const date = stamp.toDate();
    if (date instanceof Date && Number.isFinite(date.getTime())) return date;
  }
  if (stamp && Number.isFinite(stamp.seconds)) {
    const date = new Date(stamp.seconds * 1000 + Math.floor((stamp.nanoseconds || 0) / 1000000));
    if (Number.isFinite(date.getTime())) return date;
  }
  const date = new Date(String(v.created_key || ''));
  return Number.isFinite(date.getTime()) ? date : null;
}

export function reportDateKey(f) {
  const date = reportTime(f);
  if (!date) return String((f || {}).date || '');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:'Asia/Jerusalem', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return value.year + '-' + value.month + '-' + value.day;
}

export function compareReportTime(a, b) {
  const aa = reportTime(a), bb = reportTime(b);
  if (aa && bb) return bb.getTime() - aa.getTime();
  return String((b || {}).created_key || '').localeCompare(String((a || {}).created_key || ''));
}

// "מי דיווח, מתי" — local Israel time, including daylight-saving transitions.
export function reportedLine(f) {
  const v = f || {};
  const who = v.by_name || 'לא ידוע';
  const date = reportTime(v);
  if (!date) return who;
  const parts = new Intl.DateTimeFormat('he-IL', {
    timeZone:'Asia/Jerusalem', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return who + ' · ' + Number(value.day) + '.' + Number(value.month) + '.' + value.year +
    ' ' + value.hour + ':' + value.minute;
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
    return f && f.crew === crew && reportDateKey(f) === String(dateKey);
  });
  const carried = all.filter(function (f) {
    if (!f || !isOpen(f)) return false;
    if (f.crew === crew && reportDateKey(f) === String(dateKey)) return false;
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
//  הדיווח האחרון
// ------------------------------------------------------------------
//
// אלדד: "בכל מקום שיש לדווח כל סוג של תקלה — להראות רק את
// העדכנית ביותר, ולחיצה תפתח לוג היסטוריה של הרכב."
//
// **הסכנה שבזה, ומה שנבנה כדי לנטרל אותה.** אם השורה מציגה
// רק את האחרון, תקלה משביתה מלפני שלושה ימים נעלמת מתחת
// לשריטה שדווחה הבוקר — והמפקד הנכנס מקבל רכב שנראה תקין.
//
// לכן השורה מציגה **שני** דברים מקורות שונים:
//
//   המלל          הדיווח האחרון
//   התג והצבע     החומרה **הגרועה ביותר שעדיין פתוחה**
//   המונה         כמה דיווחים יש בסך הכל על הנושא
//
// כך "רכב אלמוג · פנס שרוף" יכול להופיע עם תג אדום "משבית",
// ואז ברור שיש שם עוד משהו וצריך ללחוץ.

export function normTitle(t) {
  return String(t || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// נושא = הרכב, ואם אין רכב — הכותרת. כך גם "מסכה מספר 4"
// צוברת היסטוריה משלה, בדיוק כמו רכב.
export function subjectKey(f) {
  const v = f || {};
  return v.vehicle_id ? 'v:' + v.vehicle_id
    : 't:' + String(v.kind || '') + ':' + normTitle(v.title);
}

export function subjectName(f) {
  const v = f || {};
  return v.vehicle_name || v.title || 'ללא שם';
}

export function latestOf(list) {
  return (list || []).slice().sort(function (a, b) {
    return compareReportTime(a, b);
  })[0] || null;
}

// כל הדיווחים על אותו נושא — מה שנפתח בלחיצה.
export function subjectLog(faults, f) {
  const k = subjectKey(f);
  return sortFaults((faults || []).filter(function (x) {
    return x && subjectKey(x) === k;
  }));
}

// קיבוץ לשורה אחת לכל נושא.
export function bySubject(list, all) {
  const groups = {};
  (list || []).forEach(function (f) {
    if (!f) return;
    const k = subjectKey(f);
    if (!groups[k]) groups[k] = [];
    groups[k].push(f);
  });

  const rows = Object.keys(groups).map(function (k) {
    const shown = groups[k];
    // ההיסטוריה נמדדת על כל התקלות, לא רק על אלה שבמדור.
    // אחרת "3 דיווחים" יהפוך ל"1" ברגע שהשניים האחרים נסגרו,
    // וזו בדיוק ההיסטוריה שרוצים לראות.
    const hist = all ? subjectLog(all, shown[0]) : sortFaults(shown);
    const open = shown.filter(isOpen);
    const pool = open.length ? open : shown;
    const worst = pool.reduce(function (a, f) {
      return sevRank(f.severity) < sevRank(a.severity) ? f : a;
    }, pool[0]);
    const last = latestOf(shown);
    return {
      key: k,
      name: subjectName(last),
      // הכותרת הקטנה מעל המלל. לרכב — שם הרכב. לפריט בלי
      // רכב — **סוג הדיווח**, ולא הכותרת: היא כבר מופיעה
      // בשורה מתחת, ושורה שחוזרת על עצמה היא רעש.
      head: (last && last.vehicle_id) ? subjectName(last)
                                      : kindHe((last || {}).kind),
      vehicle_id: (last && last.vehicle_id) || '',
      latest: last,
      list: sortFaults(shown),
      history: hist,
      count: shown.length,
      hist_count: hist.length,
      sev: (worst && worst.severity) || 'unset',
      color: sevColor((worst && worst.severity) || 'unset'),
      sev_he: sevHe((worst && worst.severity) || 'unset')
    };
  });

  // החמור קודם, ובתוך אותה חומרה — האחרון שדווח קודם.
  rows.sort(function (a, b) {
    const r = sevRank(a.sev) - sevRank(b.sev);
    if (r) return r;
    return compareReportTime(a.latest, b.latest);
  });
  return rows;
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

// Camera pickers on mobile replace their FileList on every capture. Keep an
// explicit appendable queue instead of treating the latest input as all photos.
export function createPhotoQueue(limit = 3) {
  let files = [];
  return Object.freeze({
    add(selected) {
      const incoming = Array.from(selected || []);
      if (files.length + incoming.length > limit) return false;
      files = files.concat(incoming);
      return true;
    },
    remove(index) {
      if (!Number.isInteger(index) || index < 0 || index >= files.length) return false;
      files.splice(index, 1);
      return true;
    },
    list() { return files.slice(); },
    clear() { files = []; }
  });
}

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
