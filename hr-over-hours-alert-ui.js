/* ======================================================================
 *  hr-over-hours-alert-ui — משטח הניטור והדוח החודשי במסך משאבי אנוש
 *
 *  ----------------------------------------------------------------
 *  ⭐ „אין דוח" אינו „אין חורגים"
 *  ----------------------------------------------------------------
 *  הגרסה הקודמת קראה את `getHrOverHoursAlert`, שקורא את המסמך העדכני
 *  ב-`hr_reports`. אימתנו: **הכותב היחיד של `hr_reports` היה
 *  `buildAndSendMonthly`, ואין לו אף קורא** — `monthlyHrReport` פרש
 *  ל-stub, ובדיקה אוכפת שהוא יישאר כך. כלומר לפאנל החריגות לא היה
 *  מקור נתונים בכלל:
 *
 *    · בתחנה שהעבודה רצה בה פעם — הוצג החודש האחרון שלפני הפרישה,
 *      **כאילו הוא עכשיו**, בלי שום סימן שהוא ישן.
 *    · בכל תחנה אחרת — ריק. וריק נקרא „אין חורגים".
 *
 *  שני המצבים האלה נראים זהים, וזה בדיוק ההבדל שחייב להיות גלוי.
 *  לכן שלושה מצבים נפרדים, ולא שניים:
 *
 *    1. `over`      — יש דוח, ויש חורגים. רשימה.
 *    2. `clear`     — יש דוח, ואין חורגים. נאמר במפורש, עם החודש והסף.
 *    3. `not_built` — אין דוח מאושר לחודש. „הדוח החודשי טרם הופק".
 *
 *  מצב 3 אינו מוצג כ„אין חורגים" בשום מסלול, והאריח מציג „—" ולא „0":
 *  אפס הוא תשובה, ומקף הוא היעדר תשובה.
 *
 *  ----------------------------------------------------------------
 *  שני רכיבים בקובץ אחד, וזו החלטה ולא נוחות
 *  ----------------------------------------------------------------
 *  `firebase-messaging-sw.js` מונה במפורש את מודולי המעטפת, והוא
 *  קובץ בבעלות חבילת Codex. מודול חדש היה מחייב לגעת בו — ומודול
 *  שמסך המעטפת מייבא ואינו ב-SHELL הוא מסך שנשבר במצב לא מקוון.
 *  לכן שני הרכיבים — ההתראה והדוח — יושבים בקובץ שכבר ברשימה.
 *
 *  ----------------------------------------------------------------
 *  מה זה אינו
 *  ----------------------------------------------------------------
 *  חריגת שעות היא **התרעת ניטור בלבד**: אין כאן אישור, אין דחייה,
 *  ואין חסימת שיבוץ או פרסום. הסף מגיע מהשרת לפי התחנה, ולא מקובע
 *  כאן. ואם הכיסוי אינו שלם — הדוח אומר זאת, ולא מוצג כשלם.
 * ====================================================================== */

const disconnected = { currentSession: () => null, subscribeIdentity: () => () => {} };

const NOT_BUILT = 'הדוח החודשי טרם הופק. אין נתוני חריגה לחודש הזה — וזה אינו „אין חורגים".';
const COVERAGE_PENDING = 'הדוח אינו מוצג כשלם: ייתכנו דיווחי היעדרות שנפתחו לפני שהשיוך לחודש קיים, והם אינם נספרים בו. סיווג הדיווחים הישנים טרם הושלם.';
const number = new Intl.NumberFormat('he-IL');

function sessionKey(adapter) {
  try {
    const s = adapter.currentSession();
    return s && (s.super === true || s.role === 'hr_coordinator')
      ? JSON.stringify([s.uid, s.stationId, s.role, s.super === true, s.epoch]) : null;
  } catch (_) { return null; }
}

/* התשובה נבדקת עד הסוף. מצב שאינו מהאוצר, או רשימה שאינה בצורה
 * הנכונה, אינם מוצגים „חלקית": מספר על המסך נקרא כעובדה. */
const STATES = ['over', 'clear', 'not_built'];
function validStatus(value) {
  if (!value || typeof value !== 'object' || !STATES.includes(value.state)) return false;
  if (value.state === 'not_built') return true;
  return (typeof value.month === 'string' && !!value.month)
    && (value.hour_limit === null || (typeof value.hour_limit === 'number' && Number.isFinite(value.hour_limit)))
    && ['complete', 'legacy_pending'].includes(value.coverage)
    && Array.isArray(value.over_employees) && value.over_employees.length <= 200
    && value.over_employees.every(e => e && typeof e === 'object'
      && typeof e.employee_number === 'string' && typeof e.crew === 'string'
      && typeof e.full_name === 'string' && !!e.full_name
      && typeof e.total_hours === 'number' && Number.isFinite(e.total_hours))
    && (value.state === 'over') === (value.over_employees.length > 0);
}

export function createHrOverHoursAlertUI(root, adapter = disconnected) {
  const q = key => root.querySelector(`[data-oh="${key}"]`);
  let owner = null, generation = 0, disposed = false, busy = false;
  const alive = (g, key) => !disposed && g === generation && key === owner && key === sessionKey(adapter);

  const build = q('build');
  const retry = q('retry');

  function paint(status, failure) {
    const box = q('alert');
    const list = q('list');
    list.replaceChildren();
    if (build) build.hidden = true;
    if (retry) retry.hidden = !failure;
    if (failure) {
      // כשל קריאה אינו „אין חורגים" ואינו „אין דוח". הוא כשל, ואומר זאת.
      q('count').textContent = '—';
      box.hidden = false;
      q('meta').textContent = 'מצב החריגות אינו זמין כרגע. אין מכאן מה להסיק על חריגות.';
      return;
    }
    if (!status) { q('count').textContent = '—'; box.hidden = true; q('meta').textContent = ''; return; }
    if (status.state === 'not_built') {
      // ⭐ מקף, לא אפס.
      q('count').textContent = '—';
      box.hidden = false;
      q('meta').textContent = NOT_BUILT;
      if (build) build.hidden = false;
      return;
    }
    const limit = status.hour_limit === null ? null : status.hour_limit;
    const head = 'דוח ' + status.month + (limit === null ? '' : ' · סף ' + number.format(limit) + ' שעות')
      + ' · לידיעה ומעקב בלבד — אינו חוסם סידור, פרסום או אישור.';
    box.hidden = false;
    if (status.state === 'clear') {
      q('count').textContent = '0';
      q('meta').textContent = head + ' אין עובדים מעל הסף בחודש הזה.';
    } else {
      q('count').textContent = number.format(status.over_employees.length);
      q('meta').textContent = head;
      for (const person of status.over_employees) {
        const item = document.createElement('li');
        item.textContent = person.full_name
          + (person.employee_number ? ' · מספר עובד ' + person.employee_number : '')
          + (person.crew ? ' · ' + person.crew : '')
          + ' — ' + number.format(person.total_hours) + ' שעות';
        list.append(item);
      }
    }
    if (status.coverage === 'legacy_pending') {
      const note = document.createElement('li');
      note.textContent = COVERAGE_PENDING;
      list.append(note);
    }
  }

  async function load() {
    if (!owner) return;
    const g = generation, key = owner;
    try {
      const out = await adapter.overHoursStatus();
      if (!alive(g, key)) return;
      if (!validStatus(out)) throw Error('invalid response');
      paint(out, false);
    } catch (_) {
      if (alive(g, key)) paint(null, true);
    }
  }

  async function buildNow() {
    if (!owner || busy || typeof adapter.buildMonthly !== 'function') return;
    const g = generation, key = owner;
    busy = true;
    if (build) { build.disabled = true; build.setAttribute('aria-busy', 'true'); }
    q('meta').textContent = 'מפיק את הדוח החודשי…';
    try {
      await adapter.buildMonthly();
      if (!alive(g, key)) return;
      await load();
    } catch (_) {
      if (alive(g, key)) { q('meta').textContent = 'הפקת הדוח לא הושלמה. אפשר לנסות שוב.'; }
    } finally {
      if (alive(g, key)) { busy = false; if (build) { build.disabled = false; build.setAttribute('aria-busy', 'false'); } }
    }
  }

  if (build) build.addEventListener('click', () => { void buildNow(); });
  if (retry) retry.addEventListener('click', () => { void load(); });

  const unsubscribe = adapter.subscribeIdentity(() => {
    const next = sessionKey(adapter); if (next === owner) return;
    owner = next; ++generation; busy = false; paint(null, false);
    if (owner) void load();
  });
  owner = sessionKey(adapter); paint(null, false);
  if (owner) void load();
  return { destroy() { disposed = true; ++generation; unsubscribe(); } };
}

/* ======================================================================
 *  הדוח החודשי המאוחד — טעינה לפי דרישה, מעומדת
 *
 *  נטען בלחיצה ולא בפתיחת המסך: הוא 3,000 שורות אפשריות, ואין סיבה
 *  לשלם עליהן כדי לראות את אריח החריגות. הקריאה מעומדת, והעמוד הבא
 *  נמשך רק כשמבקשים אותו.
 * ====================================================================== */
export function createHrMonthlyReportUI(root, adapter = disconnected, { monthElement } = {}) {
  const q = key => root.querySelector(`[data-mr="${key}"]`);
  let owner = null, generation = 0, disposed = false, loading = false;
  let cursor = null, rows = [], head = null;
  const alive = (g, key) => !disposed && g === generation && key === owner && key === sessionKey(adapter);
  const month = () => (monthElement && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthElement.value) ? monthElement.value : null);

  const validRow = row => row && typeof row === 'object'
    && typeof row.uid === 'string' && !!row.uid
    && typeof row.employee_number === 'string' && typeof row.full_name === 'string'
    && typeof row.crew === 'string'
    && (row.total_hours === null || (typeof row.total_hours === 'number' && Number.isFinite(row.total_hours)))
    && ['approved_sick_days', 'approved_reserve_days', 'approved_vacation_days',
      'approved_extended_absence_days', 'pending_sick_days', 'pending_reserve_days',
      'pending_vacation_days', 'pending_extended_absence_days']
      .every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)
    && typeof row.over_hour_limit === 'boolean';

  function message(value) { q('message').textContent = value; }

  function render() {
    const body = q('rows');
    body.replaceChildren();
    q('more').hidden = !cursor;
    q('more').disabled = loading;
    q('load').disabled = loading;
    q('coverage').hidden = !(head && head.coverage === 'legacy_pending');
    if (head && head.coverage === 'legacy_pending') q('coverage').textContent = COVERAGE_PENDING;
    q('head').textContent = head && head.state === 'ready'
      ? 'דוח ' + head.month + ' · ' + number.format(head.total_rows || rows.length) + ' עובדים · סף '
        + (head.hour_limit === null ? '—' : number.format(head.hour_limit)) + ' שעות'
        + (head.delivery === 'in_app_only' ? ' · נשמר ומוצג במערכת בלבד; אינו נשלח בדואר.' : '')
      : '';
    for (const row of rows) {
      const line = document.createElement('tr');
      const cells = [
        row.employee_number || '—',
        row.full_name || '—',
        row.crew || '—',
        row.total_hours === null ? 'אין דוח' : number.format(row.total_hours),
        number.format(row.approved_sick_days),
        number.format(row.approved_reserve_days),
        number.format(row.approved_vacation_days),
        row.long_absence ? (row.long_absence.open_ended ? 'פתוחה' : 'כן')
          : row.approved_extended_absence_days > 0 ? number.format(row.approved_extended_absence_days) + ' ימים' : '—',
        [row.pending_sick_days, row.pending_reserve_days, row.pending_vacation_days,
          row.pending_extended_absence_days].reduce((sum, value) => sum + value, 0) === 0
          ? '—'
          : number.format([row.pending_sick_days, row.pending_reserve_days, row.pending_vacation_days,
            row.pending_extended_absence_days].reduce((sum, value) => sum + value, 0)) + ' ימים',
        row.over_hour_limit ? 'מעל הסף — לידיעה' : '—'
      ];
      for (const value of cells) {
        const cell = document.createElement('td');
        cell.textContent = String(value);
        line.append(cell);
      }
      if (row.over_hour_limit) line.dataset.over = 'true';
      body.append(line);
    }
    q('table').hidden = !rows.length;
    q('empty').hidden = !(head && head.state === 'ready' && !rows.length);
  }

  async function load(append = false) {
    const key = sessionKey(adapter);
    if (!key || loading) return;
    const selected = month();
    if (!selected) { message('בחרו חודש.'); return; }
    if (!append) { ++generation; rows = []; cursor = null; head = null; }
    const g = generation;
    owner = key; loading = true; message('טוען את הדוח…'); render();
    try {
      const out = await adapter.monthlySummary({ month: selected, ...(append && cursor ? { cursor } : {}) });
      if (!alive(g, key)) return;
      if (!out || typeof out !== 'object' || !['ready', 'not_built'].includes(out.state)
        || !Array.isArray(out.rows) || out.rows.length > 25
        || !out.rows.every(validRow)) throw Error('invalid report');
      if (out.state === 'not_built') { head = out; rows = []; cursor = null; render(); message(NOT_BUILT); return; }
      head = out;
      rows = append ? rows.concat(out.rows) : out.rows;
      cursor = typeof out.next_cursor === 'string' && out.next_cursor ? out.next_cursor : null;
      render(); message('');
    } catch (_) {
      if (alive(g, key)) { rows = []; cursor = null; head = null; render(); message('הדוח אינו זמין כרגע. אפשר לנסות שוב.'); }
    } finally { if (alive(g, key)) { loading = false; render(); } }
  }

  q('load').addEventListener('click', () => { void load(false); });
  q('more').addEventListener('click', () => { void load(true); });
  monthElement?.addEventListener('change', () => { ++generation; rows = []; cursor = null; head = null; render(); message(''); });
  const unsubscribe = adapter.subscribeIdentity(() => {
    const next = sessionKey(adapter); if (next === owner) return;
    owner = next; ++generation; rows = []; cursor = null; head = null; loading = false; render(); message('');
  });
  owner = sessionKey(adapter); render();
  return { destroy() { disposed = true; ++generation; unsubscribe(); } };
}
