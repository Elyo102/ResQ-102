// =====================================================================
//  הפקת מסמך חתום להדפסה ול-PDF
// =====================================================================
//
//  **למה הדפסת דפדפן ולא ספריית PDF.**
//
//  הדרך המקובלת היא jsPDF. היא לא מתאימה כאן משתי סיבות
//  שקשה לעקוף: היא אינה יודעת עברית בלי להטמיע קובץ גופן
//  (עוד כמה מאות קילובייט שצריך להוריד מרשת חיצונית, וה-CSP
//  של האפליקציה חוסם אותה), והיא הופכת RTL לג'יבריש הפוך.
//
//  הדפדפן כבר יודע עברית, כבר יודע RTL, וכבר יודע להפוך דף
//  ל-PDF. גם באנדרואיד וגם באייפון "שמור כ-PDF" נמצא בתוך
//  חלון ההדפסה. אז מה שנבנה כאן הוא **דף**, לא קובץ.
//
//  ההדפסה נעשית מתוך iframe מוסתר ולא מחלון חדש: חלון חדש
//  נחסם בחוסמי חלונות קופצים בטלפון, והמשתמש היה לוחץ
//  "הדפס" ולא היה קורה כלום.
//
//  מה שנכנס לדף: מה שנחתם, מי חתם, ומתי. לא יותר. מסמך
//  שמכיל שדות שלא היו במקור אינו העתק של מה שנחתם.

// ---------------------------------------------------------------
//  בניית ה-HTML
// ---------------------------------------------------------------
//
// פונקציה טהורה בכוונה — בלי document, בלי window. כך אפשר
// לבדוק אותה בלי דפדפן, וכך גם אפשר יהיה בעתיד לשלוח את
// אותו HTML במייל בלי לשכפל את הפריסה.

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function heDate(iso) {
  const s = String(iso || '');
  if (s.length < 10) return s;
  const p = s.slice(0, 10).split('-');
  const t = s.length >= 16 ? ' ' + s.slice(11, 16) : '';
  return Number(p[2]) + '.' + Number(p[1]) + '.' + p[0] + t;
}

// שורות הפרטים. כל שורה היא [תווית, ערך] — ערך ריק נופל.
function rowsHtml(rows) {
  const live = (rows || []).filter(function (r) {
    return r && r[1] != null && String(r[1]).trim() !== '';
  });
  if (!live.length) return '';
  return '<table class="kv">' + live.map(function (r) {
    return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>';
  }).join('') + '</table>';
}

// בלוק חתימה אחד.
//
// אם החתימה נעשתה בשם אדם אחר, זה נכתב **מתחת לחתימה
// ובתוך המסגרת** ולא בהערת שוליים. מסמך מודפס נקרא בעין
// אחת, והערה שנמצאת רחוק מהחתימה פשוט לא נקראת.
function signHtml(step) {
  const r = step.rec || {};
  return '<div class="sg">' +
    (r.image ? '<img src="' + esc(r.image) + '" alt="חתימה">'
             : '<div class="empty">— לא נחתם —</div>') +
    '<div class="line"></div>' +
    '<div class="lbl">' + esc(step.label) + '</div>' +
    '<div class="nm">' + esc(r.name || '') +
      (r.emp ? ' · ' + esc(r.emp) : '') + '</div>' +
    (r.at ? '<div class="at">' + esc(heDate(r.at)) + '</div>' : '') +
    (r.on_behalf_of
      ? '<div class="ob">נחתם בשם ' + esc(r.on_behalf_name || r.on_behalf_of) +
        (r.reason ? '<br>' + esc(r.reason) : '') + '</div>'
      : '') +
    '</div>';
}

export function buildDocHtml(o) {
  const opt = o || {};
  const steps = opt.signatures || [];

  return '<!DOCTYPE html><html lang="he" dir="rtl"><head>' +
  '<meta charset="UTF-8">' +
  '<title>' + esc(opt.title || 'מסמך') + '</title>' +
  '<style>' +
  '@page{ size:A4; margin:16mm 14mm }' +
  '*{ box-sizing:border-box }' +
  'body{ margin:0; direction:rtl; color:#111; background:#fff;' +
  '      font-family:"Segoe UI",Arial,sans-serif; font-size:12pt; line-height:1.6 }' +
  '.hd{ display:flex; align-items:flex-start; gap:12px;' +
  '     border-bottom:2px solid #111; padding-bottom:9px; margin-bottom:14px }' +
  '.hd .t{ flex:1 }' +
  '.hd h1{ font-size:17pt; margin:0 0 2px }' +
  '.hd .st{ font-size:10.5pt; color:#444 }' +
  '.hd .id{ font-size:9pt; color:#666; white-space:nowrap; padding-top:3px }' +
  '.tag{ display:inline-block; border:1px solid #111; border-radius:3px;' +
  '      padding:1px 8px; font-size:9.5pt; font-weight:700; margin-top:4px }' +
  'table.kv{ width:100%; border-collapse:collapse; margin-bottom:14px }' +
  'table.kv th{ text-align:right; width:33%; font-weight:600; color:#333;' +
  '             vertical-align:top; padding:5px 0 5px 10px;' +
  '             border-bottom:1px solid #ddd; font-size:11pt }' +
  'table.kv td{ padding:5px 0; border-bottom:1px solid #ddd;' +
  '             white-space:pre-line }' +
  'h2{ font-size:12pt; margin:16px 0 7px; padding-bottom:3px;' +
  '    border-bottom:1px solid #999 }' +
  // החתימות לעולם לא נחתכות בין עמודים. חתימה שחציה בעמוד
  // אחד וחציה בשני אינה ראיה לכלום.
  '.sigs{ display:flex; flex-wrap:wrap; gap:14px; margin-top:6px;' +
  '       page-break-inside:avoid; break-inside:avoid }' +
  '.sg{ flex:1 1 150px; min-width:150px; max-width:230px;' +
  '     page-break-inside:avoid; break-inside:avoid; text-align:center }' +
  '.sg img{ height:52px; max-width:100%; object-fit:contain; display:block;' +
  '         margin:0 auto 2px }' +
  '.sg .empty{ height:52px; display:flex; align-items:center;' +
  '            justify-content:center; color:#999; font-size:10pt }' +
  '.sg .line{ border-top:1px solid #111; margin-bottom:3px }' +
  '.sg .lbl{ font-weight:700; font-size:10.5pt }' +
  '.sg .nm{ font-size:10pt; color:#333 }' +
  '.sg .at{ font-size:9pt; color:#666 }' +
  '.sg .ob{ font-size:8.5pt; color:#000; margin-top:3px;' +
  '         border:1px solid #111; border-radius:3px; padding:2px 4px }' +
  '.ft{ margin-top:20px; padding-top:7px; border-top:1px solid #ccc;' +
  '     font-size:8.5pt; color:#666; display:flex; justify-content:space-between;' +
  '     gap:10px }' +
  '@media print{ body{ font-size:11pt } .noprint{ display:none } }' +
  '</style></head><body>' +

  '<div class="hd">' +
    '<div class="t">' +
      '<h1>' + esc(opt.title || 'מסמך') + '</h1>' +
      '<div class="st">' + esc(opt.station || '') + '</div>' +
      (opt.status ? '<div class="tag">' + esc(opt.status) + '</div>' : '') +
    '</div>' +
    (opt.docId ? '<div class="id">מס׳ מסמך<br>' + esc(opt.docId) + '</div>' : '') +
  '</div>' +

  (opt.meta && opt.meta.length ? rowsHtml(opt.meta) : '') +
  (opt.rows && opt.rows.length
     ? '<h2>פרטי הטופס</h2>' + rowsHtml(opt.rows) : '') +
  (opt.note ? '<h2>הערות</h2><div>' + esc(opt.note) + '</div>' : '') +

  (steps.length
     ? '<h2>חתימות</h2><div class="sigs">' +
       steps.map(signHtml).join('') + '</div>'
     : '') +

  '<div class="ft">' +
    '<span>' + esc(opt.footer || 'הופק ממערכת ResQ') + '</span>' +
    '<span>' + esc(opt.printedAt || '') + '</span>' +
  '</div>' +
  '</body></html>';
}

// ---------------------------------------------------------------
//  ההדפסה עצמה
// ---------------------------------------------------------------
//
// iframe מוסתר, לא חלון חדש. ראה למעלה.
//
// ה-iframe מוסר אחרי ההדפסה — אבל לא מיד: בכמה דפדפנים
// print() חוזר לפני שדיאלוג ההדפסה סיים לקרוא את הדף,
// והסרה מיידית הייתה מדפיסה עמוד ריק.

export function printHtml(html) {
  return new Promise(function (resolve, reject) {
    let fr = null;
    try {
      fr = document.createElement('iframe');
      fr.setAttribute('aria-hidden', 'true');
      fr.style.cssText =
        'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0';
      document.body.appendChild(fr);

      const d = fr.contentWindow.document;
      d.open(); d.write(html); d.close();

      const go = function () {
        try {
          fr.contentWindow.focus();
          fr.contentWindow.print();
          resolve(true);
        } catch (e) {
          reject(e);
        }
        setTimeout(function () {
          if (fr && fr.parentNode) fr.parentNode.removeChild(fr);
        }, 60000);
      };

      // ממתינים לתמונות. חתימה היא data URI ולכן נטענת מיד,
      // אבל "מיד" אינו "לפני הציור" — הדפסה לפני שהתמונה
      // נכנסה לפריסה מוציאה חתימות ריקות.
      if (fr.contentWindow.document.readyState === 'complete') setTimeout(go, 120);
      else fr.contentWindow.addEventListener('load', function () { setTimeout(go, 120); });
    } catch (e) {
      if (fr && fr.parentNode) fr.parentNode.removeChild(fr);
      reject(e);
    }
  });
}

// ---------------------------------------------------------------
//  מטופס שהוגש אל מסמך
// ---------------------------------------------------------------
//
// כאן יושב הידע על **מבנה** ההגשה. המסך שקורא לפונקציה
// אינו צריך לדעת ש-signatures הוא מפה ושהשלבים נקראים
// employee/commander/station_commander.

export function submissionDoc(sub, form, opt) {
  const s = sub || {};
  const o = opt || {};
  const v = s.values || {};

  const rows = (form && form.fields ? form.fields : []).map(function (f) {
    const raw = v[f.id];
    if (raw == null || String(raw).trim() === '') return null;
    // תאריך בלבד — בלי "00:00" נגרר. heDate מוסיף שעה רק
    // כשהמחרוזת באמת מכילה אחת.
    return [f.he, f.type === 'date' ? heDate(String(raw)) : raw];
  }).filter(Boolean);

  // שדות שנשמרו בהגשה אבל אינם מוגדרים בטופס הנוכחי —
  // למשל טופס שהשתנה מאז. הם מוצגים בכל זאת: מה שנחתם
  // נחתם, וטופס שאיבד שדה בדיעבד אינו העתק נאמן.
  const known = {};
  (form && form.fields ? form.fields : []).forEach(function (f) { known[f.id] = true; });
  Object.keys(v).forEach(function (k) {
    if (known[k]) return;
    if (v[k] == null || String(v[k]).trim() === '') return;
    rows.push([k, v[k]]);
  });

  const sigs = s.signatures || {};
  const steps = (o.steps || ['employee', 'commander', 'station_commander'])
    .filter(function (k) { return sigs[k] || k !== 'station_commander'; })
    .map(function (k) {
      return { label: (o.labels && o.labels[k]) || k, rec: sigs[k] || null };
    });

  // מסמך ישן, מלפני מבנה השרשרת: חתימה שטוחה אחת.
  if (!Object.keys(sigs).length && s.signature) {
    steps.length = 0;
    steps.push({ label: (o.labels && o.labels.employee) || 'הכבאי',
                 rec: { image: s.signature, name: s.by_name || '',
                        emp: s.by_emp || '', at: s.created_key || '' } });
  }

  return {
    title: s.form_he || (form && form.he) || 'טופס',
    station: o.station || '',
    status: o.statusHe || '',
    docId: s.id || '',
    meta: [
      ['שם המגיש',    s.by_name || ''],
      ['מספר עובד',   s.by_emp || ''],
      ['משמרת',       o.crewHe || s.crew || ''],
      ['תאריך הגשה',  heDate(s.created_key || '')],
      ['הוכרע בידי',  s.decided_by_name || ''],
      ['תאריך הכרעה', heDate(s.decided_key || '')]
    ],
    rows: rows,
    note: s.decide_note || '',
    signatures: steps,
    footer: o.footer || 'הופק ממערכת ResQ',
    printedAt: o.printedAt || ''
  };
}
