// דוח נוכחות חודשי — הפורמט שנשלח למשאבי אנוש.
//
// המבנה נלקח מהדוח שאלדד שלח: שם, חודש ותחנה בראש, טבלה עם
// תאריך, סוג יום, כניסה, יציאה, מקום, הערות ושעות, שורת אזהרה
// על ימים בלי נימוק, וסך שעות בסוף.
//
// הקובץ מייצר HTML בלבד ואינו מחשב שעות. השעות מגיעות מוכנות
// מהרשומה — אותו מספר שהמסך הראה ושהמשתמש אישר. אם החישוב
// היה חוזר כאן, היה אפשר לקבל דוח שאומר מספר אחד והמסך אומר
// אחר, וזה בדיוק סוג הפער שהמערכת הישנה סבלה ממנו.

const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני',
                'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dmy(dateKey) {
  const p = String(dateKey).split('-');
  return Number(p[2]) + '.' + Number(p[1]);
}

function monthHe(monthKey) {
  const p = String(monthKey).split('-');
  return (MONTHS[Number(p[1]) - 1] || p[1]) + ' ' + p[0];
}

export const REPORT_CSS = [
  'body{font-family:"Segoe UI",Arial,sans-serif;direction:rtl;color:#222;',
  '  background:#fff;margin:0;padding:26px 30px}',
  '.nm{font-size:27px;font-weight:800;color:#c62828;margin:0 0 3px}',
  '.sub{font-size:14px;color:#555;margin-bottom:16px}',
  '.sub b{color:#c62828}',
  '.sites{margin:0 0 14px}',
  '.site{display:inline-block;border:1px solid #ddd;border-radius:6px;',
  '  padding:3px 12px;font-size:13px;color:#6a1b9a;font-weight:700;',
  '  margin-inline-end:6px}',
  'table{width:100%;border-collapse:collapse;font-size:13.5px}',
  'th{background:#f4f6f8;color:#1565c0;font-weight:700;font-size:13px;',
  '  padding:9px 8px;border:1px solid #dde3e8;white-space:nowrap}',
  'td{padding:9px 8px;border:1px solid #e6eaee;text-align:center}',
  'td.txt{text-align:right}',
  'tr:nth-child(even) td{background:#fafbfc}',
  'td.hrs{font-weight:800;font-variant-numeric:tabular-nums}',
  '.rng{direction:ltr;unicode-bidi:isolate;display:inline-block}',
  '.flag{color:#c62828;font-weight:700}',
  '.mark{border-inline-start:4px solid #6a1b9a}',
  '.type-flag{color:#6a1b9a;font-weight:700}',
  '.warn{border:2px solid #c62828;border-radius:8px;padding:13px;',
  '  margin-top:16px;text-align:center;color:#c62828;font-weight:700;',
  '  font-size:14.5px}',
  '.total{border:2px solid #c62828;border-radius:8px;padding:17px;',
  '  margin-top:14px;text-align:center;font-size:22px;font-weight:800}',
  '.foot{margin-top:16px;text-align:center;color:#888;font-size:11.5px}',
  '@media print{body{padding:0} .total,.warn{break-inside:avoid}}'
].join('');

// rows: [{date, day_type_he, start, end, end_day, start2, end2,
//         site_name, site_fixed, notes, hours, reason, reason_why}]
//
// head: {full_name, month, station_name, status, total, over_limit}
export function reportHtml(head, rows) {
  const h = head || {};
  const list = (rows || []).slice().sort(function (a, b) {
    return String(a.date).localeCompare(String(b.date));
  });

  const sites = {};
  list.forEach(function (r) { if (r.site_name) sites[r.site_name] = true; });

  const body = list.map(function (r) {
    const marked = !!r.site_fixed;
    const rng = function (a, b) {
      if (!a && !b) return '—';
      return '<span class="rng">' + esc(a || '—') + '</span>';
    };
    const times = r.start
      ? '<td><span class="rng">' + esc(r.start) + '</span></td>' +
        '<td><span class="rng">' + esc(r.end || '—') + '</span></td>'
      : '<td>—</td><td>—</td>';

    // אין כאן סימון "לא צוינה סיבה". השמירה חסומה בלי נימוק
    // בימים שדורשים אותו, ולכן יום כזה לא יכול להגיע לדוח —
    // וכיתוב שלא יופיע לעולם הוא רעש.
    const note = esc(r.reason || r.notes || '');

    return '<tr>' +
      '<td class="' + (marked ? 'mark' : '') + '">' + esc(dmy(r.date)) + '</td>' +
      '<td class="' + (marked ? 'type-flag' : '') + '">' +
        (marked ? '◆ ' : '') + esc(r.day_type_he || '') + '</td>' +
      times +
      '<td>' + esc(r.site_name || '') + '</td>' +
      '<td class="txt">' + note +
        (r.start2 ? ' <span class="rng">(' + esc(r.start2) + '–' +
                    esc(r.end2) + ')</span>' : '') + '</td>' +
      '<td class="hrs">' + (r.hours == null ? '—' : r.hours) + '</td>' +
    '</tr>';
  }).join('');

  return [
    '<div class="nm">', esc(h.full_name || ''), '</div>',
    '<div class="sub">דוח נוכחות · ', esc(monthHe(h.month || '')),
      ' · ', esc(h.station_name || ''), ' · <b>',
      esc(h.status === 'approved' ? 'אושר' :
          h.status === 'submitted' ? 'ממתין לאישור' : 'טרם אושר על ידי הכבאי'),
      '</b></div>',

    Object.keys(sites).length
      ? '<div class="sites">' + Object.keys(sites).map(function (s) {
          return '<span class="site">◆ ' + esc(s) + '</span>'; }).join('') + '</div>'
      : '',

    '<table><thead><tr>',
      '<th>תאריך</th><th>סוג יום</th><th>כניסה</th><th>יציאה</th>',
      '<th>מקום</th><th>הערות</th><th>שעות</th>',
    '</tr></thead><tbody>', body, '</tbody></table>',

    h.over_limit
      ? '<div class="warn">⚠ חריגה — סך השעות עובר את הסף שנקבע (' +
        esc(h.over_limit) + ')</div>'
      : '',

    '<div class="total">סך שעות החודש: ', String(h.total == null ? '—' : h.total),
    '</div>',
    '<div class="foot">הופק אוטומטית ממערכת ResQ · ', esc(h.station_name || ''),
    '</div>'
  ].join('');
}

export function reportPage(head, rows) {
  return '<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8">' +
    '<title>' + esc((head || {}).full_name || '') + ' — דוח נוכחות</title>' +
    '<style>' + REPORT_CSS + '</style></head><body>' +
    reportHtml(head, rows) + '</body></html>';
}
