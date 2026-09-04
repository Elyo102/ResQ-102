'use strict';

/* ======================================================================
 * ייבוא סידור מהגיליון הקיים — מודול טהור (הכרעת אלדד 4.9.2026, „אפשרות ב׳")
 *
 * **הגיליון הישן הוא מסד הנתונים.** אחראי הסידור מעתיק את הגיליון
 * (Ctrl+A → העתק) ומדביק; המודול הזה מפרק את ההדבקה **לפי התוויות
 * בעמודת התוויות** (אילת · שחמון · תמנע · יטבתה · מחלה · מילואים ·
 * קורסים · חופש/באילת/בצפון/חו"ל) — לא לפי מספרי שורות. שורות שזזות
 * בגיליון אינן שוברות את הייבוא; תווית שאינה מוכרת מדווחת ולא מנוחשת.
 *
 * מה יוצא מכאן: שורות תוכנית בצורה של המנוע (`rows`, `slots[].source =
 * 'imported'`), היעדרויות ליום (`absences`), שמות שלא זוהו
 * (`unresolved`) וכפילויות (`duplicates`). **המנוע אינו מריץ על זה
 * כללים** — הגיליון מפורסם כמות שהוא; הקו האדום מוצג אם התחנה מתחת
 * לקו, אבל אינו חוסם (זו הכרעת אדם שכבר נעשתה בגיליון).
 *
 * המודול אינו קורא דבר: מקבל טקסט, אנשים, כינויים ומדיניות; מחזיר
 * ערכים. שמות אמיתיים אינם חלק מהקוד — ההתאמה נעשית מול המקור
 * שנמסר לו.
 * ====================================================================== */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const MAX_CELLS = 40000;
const MAX_NAMES_PER_CELL = 40;   // תא עם יותר מזה — מדווח ומדולג כולו, לא נחתך בשקט
const MAX_ROWS = 400;
const MAX_CELL_CHARS = 2000;
const CANONICAL_STATIONS = Object.freeze(['eilat', 'shahmon', 'timna', 'yotvata']);
const CANONICAL_STATION_LABELS = Object.freeze({
  eilat: 'אילת', shahmon: 'שחמון', timna: 'תמנע', yotvata: 'יטבתה'
});
const CANONICAL_STATION_MINIMUMS = Object.freeze({ eilat: 7, shahmon: 0, timna: 0, yotvata: 0 });

class SheetImportError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SheetImportError';
    this.code = code;
  }
}
function fail(code, message) { throw new SheetImportError(code, message); }
function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/* ---------------- טקסט ---------------- */

function normText(s) {
  return String(s == null ? '' : s)
    .replace(/[‎‏‪-‮]/g, '')   // סימני כיוון
    .replace(/["'׳״]/g, '')
    .replace(/[ְּ-ֽֿׁׂ]/g, '') // ניקוד
    .replace(/\s+/g, ' ')
    .trim();
}
function normKey(s) { return normText(s).toLowerCase(); }

/* ---------------- תוויות ---------------- */

const ABSENCE_KINDS = Object.freeze(['sick', 'reserve', 'course', 'leave']);
const LOCATIONS = Object.freeze(['abroad', 'north', 'eilat']);

// זיהוי תווית של שורת היעדרות. מחזיר null כשאינה כזו.
function absenceLabel(label) {
  const t = normKey(label);
  if (!t) return null;
  if (/מחלה|מחלת|חולה/.test(t)) return { kind: 'sick', location: null };
  if (/מילואים|מלואים/.test(t)) return { kind: 'reserve', location: null };
  if (/קורס|השתלמ|הכשר/.test(t)) return { kind: 'course', location: null };
  // \b אינו עובד עם עברית — בדיקה מפורשת של מילה שלמה.
  const words = t.split(' ');
  const abroad = words.some((w) => w === 'חול' || w === 'בחול' || w === 'לחול') || /חו ל/.test(t);
  const north = /צפון/.test(t);
  const eilat = /אילת/.test(t);
  if (/חופש|חופשה/.test(t) || abroad || north || eilat) {
    const location = abroad ? 'abroad' : north ? 'north' : eilat ? 'eilat' : null;
    // „אילת" לבד היא תחנת קצה, לא חופש — רק „באילת" / „חופש אילת" הן חופש.
    if (location === 'eilat' && !/חופש|באילת/.test(t)) return null;
    return { kind: 'leave', location };
  }
  return null;
}

// התאמת תווית של בלוק לתחנת קצה במדיניות: לפי התווית או לפי המזהה.
function stationForLabel(label, policy) {
  const t = normKey(label);
  if (!t || !policy || !plain(policy.sub_stations)) return null;
  const keys = Object.keys(policy.sub_stations);
  for (const key of keys) {
    const spec = policy.sub_stations[key] || {};
    if (normKey(spec.label) === t || normKey(key) === t) return key;
  }
  // תווית שמכילה את שם התחנה („תחנת אילת") — רק כשההתאמה יחידה.
  const hits = keys.filter((key) => {
    const l = normKey((policy.sub_stations[key] || {}).label);
    return l && t.indexOf(l) !== -1 && !absenceLabel(label);
  });
  return hits.length === 1 ? hits[0] : null;
}

/* ---------------- תאריכים ---------------- */

function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

// „3/9", „7/9/26", „07.09.2026", „2026-09-07" → YYYY-MM-DD בתוך החודש המבוקש, אחרת null.
function parseDateCell(raw, month) {
  const t = normText(raw).replace(/[.\-\\]/g, '/');
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  let d = null, m = null, y = null;
  let match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (match) { y = Number(match[1]); m = Number(match[2]); d = Number(match[3]); }
  else {
    match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t);
    if (!match) return null;
    d = Number(match[1]); m = Number(match[2]);
    y = match[3] === undefined ? year : (match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]));
  }
  if (m !== mon || y !== year) return null;
  if (d < 1 || d > daysInMonth(year, mon)) return null;
  return year + '-' + String(mon).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/* ---------------- תאים ---------------- */

// שמות בתא: „אלבז + הרוש", „סרוסי , בכור", „איוון,יונה". לא מפצלים על רווח
// (שם פרטי + משפחה). תא שהוא שעה/מספר/סימן — מדולג. תא עם יותר
// מ-MAX_NAMES_PER_CELL שמות אינו נחתך: הוא מוחזר כ-`null`, והקורא מדווח.
function namesInCell(raw) {
  const lines = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').split('\n');
  const names = [];
  lines.forEach((line) => {
    const t = normText(line);
    if (!t || /^\d[\d:./ -]*$/.test(t)) return;          // שעות, תאריכים
    names.push(...t.split(/\s*[,+;/]\s*|\s+ו-\s*/).map((x) => normText(x)).filter(Boolean));
  });
  return names.length > MAX_NAMES_PER_CELL ? null : names;
}

/* ---------------- הדבקה → מבנה ---------------- */

/**
 * parseSheet(text, { month }) →
 * { month, dates, columns:[{index, date}], label_column, blocks:[{label, kind, rows:[i..], cells:{date:[name]}}], warnings }
 *
 * kind: 'station' (תווית שאינה היעדרות; ההתאמה למדיניות נעשית ב-resolveSheet),
 *       'absence' (מחלה/מילואים/קורס/חופש+מיקום), 'ignored' (בלי תווית / לא זוהתה).
 */
function normalizeGrid(input) {
  if (!Array.isArray(input)) {
    const source = String(input == null ? '' : input).replace(/\r\n?/g, '\n');
    if (!source.trim()) fail('paste-empty', 'ההדבקה ריקה');
    return source.split('\n').map((line) => line.split('\t'));
  }
  if (!input.length) fail('paste-empty', 'הקובץ ריק');
  return input.map((row) => {
    if (!Array.isArray(row)) fail('matrix-row-invalid', 'מבנה הקובץ אינו טבלה תקינה');
    return row.map((cell) => {
      if (cell === null || cell === undefined) return '';
      if (!['string', 'number', 'boolean'].includes(typeof cell)) {
        fail('matrix-cell-invalid', 'תא בקובץ אינו ערך טקסטואלי');
      }
      const value = String(cell).replace(/\r\n?/g, '\n');
      if (value.length > MAX_CELL_CHARS) fail('matrix-cell-too-large', 'תא בקובץ ארוך מדי');
      return value;
    });
  });
}

function parseSheet(input, options) {
  const opts = plain(options) ? options : {};
  const month = String(opts.month || '');
  if (!MONTH_RE.test(month)) fail('month-invalid', 'חודש הייבוא חייב להיות YYYY-MM');
  const grid = normalizeGrid(input);
  if (grid.length > MAX_ROWS) fail('paste-too-many-rows', 'יותר מ-' + MAX_ROWS + ' שורות בקלט');
  const cellCount = grid.reduce((n, row) => n + row.length, 0);
  if (cellCount > MAX_CELLS) fail('paste-too-large', 'הקלט גדול מדי (' + cellCount + ' תאים)');

  // שורת התאריכים: השורה הראשונה שבה ≥3 תאים הם תאריכים של החודש המבוקש.
  let dateRow = -1;
  let columns = [];
  for (let r = 0; r < Math.min(grid.length, 12); r += 1) {
    const found = [];
    grid[r].forEach((cell, c) => {
      const date = parseDateCell(cell, month);
      if (date) found.push({ index: c, date });
    });
    if (found.length >= 3) { dateRow = r; columns = found; break; }
  }
  if (dateRow === -1) fail('dates-not-found', 'לא נמצאה שורת תאריכים לחודש ' + month);
  const seenDates = new Set();
  columns.forEach((col) => {
    if (seenDates.has(col.date)) fail('date-duplicate', 'התאריך ' + col.date + ' מופיע בשתי עמודות');
    seenDates.add(col.date);
  });
  const dates = columns.map((c) => c.date).sort();

  // עמודת התוויות: העמודה (שאינה עמודת תאריך) עם הכי הרבה תוויות מוכרות
  // מתחת לשורת התאריכים. בגיליון ימני זו עמודה A — אבל לא מניחים.
  const dateCols = new Set(columns.map((c) => c.index));
  const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
  let labelColumn = -1;
  let best = 0;
  for (let c = 0; c < width; c += 1) {
    if (dateCols.has(c)) continue;
    let score = 0;
    for (let r = dateRow + 1; r < grid.length; r += 1) {
      const v = grid[r][c];
      if (v && (absenceLabel(v) || (opts.policy && stationForLabel(v, opts.policy)))) score += 1;
    }
    if (score > best) { best = score; labelColumn = c; }
  }
  const warnings = [];
  if (labelColumn === -1) {
    // בלי מדיניות (או בלי תוויות מוכרות) — נופלים לעמודה הראשונה שאינה תאריך.
    for (let c = 0; c < width; c += 1) if (!dateCols.has(c)) { labelColumn = c; break; }
    warnings.push({ code: 'label-column-guessed', detail: 'לא זוהו תוויות מוכרות; עמודת התוויות נקבעה כעמודה הראשונה' });
  }

  // שורות → בלוקים לפי תוויות. התווית יכולה לשבת בשורה הראשונה של
  // הבלוק (תא ממוזג בהדבקה) או בשורה האחרונה (כמו שרואים בגיליון).
  const labeled = [];
  for (let r = dateRow + 1; r < grid.length; r += 1) {
    const label = normText(grid[r][labelColumn]);
    if (label) labeled.push({ row: r, label });
  }
  // שורת אותיות היום (ג / ד / ה / ראשון…) מתחת לתאריכים אינה נתון.
  const WEEKDAY_RE = /^(?:[א-ז]|ש|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|[a-z]{1,3})$/i;
  const dataRows = [];
  for (let r = dateRow + 1; r < grid.length; r += 1) {
    const hasData = columns.some((col) => {
      const v = normText(grid[r][col.index]);
      return v && !WEEKDAY_RE.test(v);
    });
    const hasLabel = !!normText(grid[r][labelColumn]);
    if (hasData || hasLabel) dataRows.push(r);
  }
  const firstDataRow = dataRows.length ? dataRows[0] : -1;
  const labelsOnTop = labeled.length > 0 && firstDataRow !== -1 && labeled[0].row <= firstDataRow;

  const blocks = [];
  if (labelsOnTop) {
    labeled.forEach((item, i) => {
      const end = i + 1 < labeled.length ? labeled[i + 1].row - 1 : grid.length - 1;
      blocks.push({ label: item.label, first: item.row, last: end });
    });
    if (firstDataRow !== -1 && labeled.length && firstDataRow < labeled[0].row) {
      blocks.unshift({ label: '', first: firstDataRow, last: labeled[0].row - 1 });
    }
  } else {
    let start = dateRow + 1;
    labeled.forEach((item) => {
      blocks.push({ label: item.label, first: start, last: item.row });
      start = item.row + 1;
    });
    if (start < grid.length && dataRows.some((r) => r >= start)) {
      blocks.push({ label: '', first: start, last: grid.length - 1 });
    }
  }

  /* גבול תחתון של בלוק תחנה: בגיליון, מתחת ליטבתה יושב אזור חופשי
   * (אבטחות, שעות, אירועים) בלי תווית משלו. תא ממוזג נמסר בהדבקה עם
   * הערך בשורה הראשונה בלבד, ולכן האזור הזה היה נבלע בבלוק שמעליו.
   * הכלל: בלוק תחנה נגמר בשורה הראשונה שבה אחד מתאי התאריך מכיל שעה
   * (12:00, 17:45-08:00). מה שאחריה עד התווית הבאה — מדווח ולא מיובא. */
  const TIME_RE = /\d{1,2}:\d{2}/;
  const split = [];
  blocks.forEach((block) => {
    const absence = absenceLabel(block.label);
    const station = !absence && opts.policy ? stationForLabel(block.label, opts.policy) : null;
    const isStation = !absence && !!(station || (!opts.policy && block.label));
    let cut = -1;
    if (isStation) {
      for (let r = block.first; r <= block.last; r += 1) {
        if (columns.some((col) => TIME_RE.test(String((grid[r] || [])[col.index] || '')))) { cut = r; break; }
      }
    }
    if (cut === -1) { split.push({ label: block.label, first: block.first, last: block.last, absence, station, kind: absence ? 'absence' : isStation ? 'station' : 'ignored' }); return; }
    if (cut > block.first) split.push({ label: block.label, first: block.first, last: cut - 1, absence, station, kind: isStation ? 'station' : 'ignored' });
    split.push({ label: '', first: cut, last: block.last, absence: null, station: null, kind: 'ignored', after: block.label });
  });

  const out = split.map((block) => {
    const cells = {};
    let names = 0;
    for (let r = block.first; r <= block.last; r += 1) {
      columns.forEach((col) => {
        const list = namesInCell(grid[r] ? grid[r][col.index] : '');
        if (list === null) {
          // יותר מדי שמות בתא אחד — לא חותכים; מדווחים, והתא כולו לא מיובא.
          warnings.push({ code: 'cell-too-many-names', row: r + 1, date: col.date, label: block.label || '',
            detail: 'בתא בשורה ' + (r + 1) + ' ליום ' + col.date + ' יש יותר מ-' + MAX_NAMES_PER_CELL + ' שמות; התא לא יובא' });
          return;
        }
        if (!list.length) return;
        if (!cells[col.date]) cells[col.date] = [];
        list.forEach((name) => { cells[col.date].push(name); names += 1; });
      });
    }
    return {
      label: block.label, kind: block.kind, sub_station: block.station,
      absence: block.absence || null,
      rows: [block.first + 1, block.last + 1],   // מספרי שורה אנושיים (1-based)
      after: block.after || null,
      names, cells
    };
  });
  out.forEach((block) => {
    if (block.kind === 'ignored' && block.names > 0) {
      warnings.push({ code: 'block-ignored', label: block.label || '(בלי תווית)', rows: block.rows, names: block.names,
        detail: 'הבלוק לא זוהה כתחנת קצה או כשורת היעדרות ולכן לא יובא' });
    }
  });
  return Object.freeze({
    month, dates: Object.freeze(dates), date_row: dateRow + 1, label_column: labelColumn + 1,
    columns: Object.freeze(columns), labels_on_top: labelsOnTop,
    blocks: Object.freeze(out), warnings: Object.freeze(warnings)
  });
}

/* ---------------- שמות → אנשים ---------------- */

function personIndex(people, aliases) {
  const byKey = new Map();   // key → Set(uid)
  const suggestions = new Map();
  const add = (key, uid) => {
    const k = normKey(key);
    if (!k) return;
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(uid);
  };
  const suggest = (key, uid) => {
    const k = normKey(key);
    if (!k) return;
    if (!suggestions.has(k)) suggestions.set(k, new Set());
    suggestions.get(k).add(uid);
  };
  const byId = new Map();
  (Array.isArray(people) ? people : []).forEach((person) => {
    if (!plain(person) || typeof person.id !== 'string' || !person.id) return;
    byId.set(person.id, person);
    add(person.full_name, person.id);
    add(person.name, person.id);
    add(person.schedule_name, person.id);
    // שם פרטי/משפחה בלבד הם הצעה, לעולם לא התאמה אוטומטית. אחראי
    // הסידור מאשר פעם אחת והכינוי נשמר; כך אדם אינו משובץ בשקט רק
    // מפני שבאותו חודש הוא היחיד עם אותו שם פרטי.
    const parts = normText(person.full_name || person.name).split(' ').filter(Boolean);
    if (parts.length > 1) { suggest(parts[0], person.id); suggest(parts[parts.length - 1], person.id); }
    (Array.isArray(person.aliases) ? person.aliases : []).forEach((a) => add(a, person.id));
  });
  const ignored = new Set();
  if (plain(aliases)) {
    Object.keys(aliases).forEach((name) => {
      const uid = aliases[name];
      if (uid === null) {
        // „זה לא שם" — אחראי הסידור סימן שהתא הזה אינו אדם (למשל „אבטחה").
        ignored.add(normKey(name));
      } else if (typeof uid === 'string' && byId.has(uid)) {
        // כינוי שנמסר במפורש גובר: הוא מצמצם לזהות אחת.
        byKey.set(normKey(name), new Set([uid]));
      }
    });
  }
  return { byKey, byId, ignored, suggestions };
}

function resolveName(index, name) {
  if (index.ignored.has(normKey(name))) return { uid: null, candidates: [], ignored: true };
  const set = index.byKey.get(normKey(name));
  if (!set || !set.size) {
    const suggested = index.suggestions.get(normKey(name));
    return { uid: null, candidates: suggested ? Array.from(suggested).sort() : [] };
  }
  if (set.size === 1) return { uid: Array.from(set)[0], candidates: [] };
  return { uid: null, candidates: Array.from(set).sort() };
}

/*
 * Existing stations may still use historical identifiers (for example
 * `main` or crew-derived keys).  Import never guesses how those identifiers
 * map to the four operational stations.  A manager must submit an explicit
 * one-to-one mapping; `null` explicitly means that the canonical station has
 * no historical predecessor.  The returned policy is import-only: it does
 * not rewrite the live policy or roster behind the user's back.
 */
function projectCanonicalPolicy(policy, rawMapping) {
  if (!plain(policy) || !plain(policy.sub_stations)) {
    fail('policy-required', 'חסרה מדיניות עם תחנות קצה');
  }
  const existing = Object.keys(policy.sub_stations);
  const hasCanonical = CANONICAL_STATIONS.every((id) =>
    Object.prototype.hasOwnProperty.call(policy.sub_stations, id));
  const mapping = {};
  if (hasCanonical && (rawMapping === undefined || rawMapping === null)) {
    CANONICAL_STATIONS.forEach((id) => { mapping[id] = id; });
  } else {
    if (!plain(rawMapping) || Object.keys(rawMapping).length !== CANONICAL_STATIONS.length
        || CANONICAL_STATIONS.some((id) => !Object.prototype.hasOwnProperty.call(rawMapping, id))) {
      fail('station-mapping-required', 'יש למפות במפורש את התחנות הישנות לאילת, שחמון, תמנע ויטבתה');
    }
    const used = new Set();
    CANONICAL_STATIONS.forEach((id) => {
      const value = rawMapping[id];
      if (value === null) { mapping[id] = null; return; }
      if (typeof value !== 'string'
          || !Object.prototype.hasOwnProperty.call(policy.sub_stations, value)) {
        fail('station-mapping-invalid', 'מיפוי התחנות אינו תואם לחוקי התחנה הפעילים');
      }
      if (used.has(value)) fail('station-mapping-duplicate', 'אי אפשר למפות תחנה ישנה אחת לשתי תחנות חדשות');
      used.add(value);
      mapping[id] = value;
    });
  }
  const subs = {};
  CANONICAL_STATIONS.forEach((id) => {
    const oldId = mapping[id];
    const old = oldId && plain(policy.sub_stations[oldId]) ? policy.sub_stations[oldId] : {};
    subs[id] = Object.assign({}, old, {
      label: CANONICAL_STATION_LABELS[id],
      minimum: Number.isInteger(old.minimum) ? old.minimum : CANONICAL_STATION_MINIMUMS[id]
    });
  });
  return Object.freeze({
    policy: Object.freeze(Object.assign({}, policy, { sub_stations: Object.freeze(subs) })),
    mapping: Object.freeze(mapping)
  });
}

/**
 * resolveSheet(parsed, { people, aliases, policy, station_id }) →
 * {
 *   rows:      [{ date, station_id, sub_station, label, minimum, slots:[{person, role:null, label:null, source:'imported'}],
 *                 gaps:[], rejected_manual:[], rotation_group:null, below_minimum, complete:true }],
 *   absences:  [{ date, uid, kind, location }],
 *   unresolved:[{ name, count, dates:[..], candidates:[uid] }],
 *   duplicates:[{ uid, date, blocks:[label] }],
 *   ignored:   [{ label, rows, names }],
 *   counts:    { assignments, absences, unresolved, duplicates, days, stations }
 * }
 * שם שלא זוהה או כפילות — מדווח **ולא נכנס**; הקורא מחליט אם לייבא.
 */
function resolveSheet(parsed, options) {
  const opts = plain(options) ? options : {};
  if (!plain(parsed) || !Array.isArray(parsed.blocks) || !Array.isArray(parsed.dates)) fail('parsed-required', 'חסר פלט של parseSheet');
  const policy = opts.policy;
  if (!policy || !plain(policy.sub_stations) || !Object.keys(policy.sub_stations).length) fail('policy-required', 'חסרה מדיניות עם תחנות קצה');
  const stationId = String(opts.station_id || '');
  if (!stationId) fail('station-required', 'חסר מזהה תחנה');
  const index = personIndex(opts.people, opts.aliases);

  const unresolved = new Map();   // name → {count, dates:Set, candidates}
  let skipped = 0;                // תאים שסומנו „לא שם"
  const noteUnresolved = (name, date, candidates) => {
    if (!unresolved.has(name)) unresolved.set(name, { name, count: 0, dates: new Set(), candidates });
    const u = unresolved.get(name);
    u.count += 1; u.dates.add(date);
  };

  // שיבוצים: ארבע תחנות הקצה הקנוניות ובאותו סדר בכל יום. תחנה שלא
  // הופיעה בקלט מקבלת coverage=missing — לא תא ריק שנראה מאומת.
  const subKeys = CANONICAL_STATIONS.slice();
  if (Object.keys(policy.sub_stations).length !== subKeys.length
      || subKeys.some((key) => !Object.prototype.hasOwnProperty.call(policy.sub_stations, key))) {
    fail('station-contract', 'חוקי התחנה חייבים לכלול את אילת, שחמון, תמנע ויטבתה');
  }
  const perDate = new Map();     // date → Map(uid → [labels])
  const slotsBy = new Map();     // sub|date → [{person}]
  parsed.blocks.forEach((block) => {
    if (block.kind !== 'station') return;
    const sub = block.sub_station || stationForLabel(block.label, policy);
    if (!sub) return;
    Object.keys(block.cells).forEach((date) => {
      block.cells[date].forEach((name) => {
        const hit = resolveName(index, name);
        if (hit.ignored) { skipped += 1; return; }
        if (!hit.uid) { noteUnresolved(name, date, hit.candidates); return; }
        if (!perDate.has(date)) perDate.set(date, new Map());
        const seen = perDate.get(date);
        if (!seen.has(hit.uid)) seen.set(hit.uid, []);
        seen.get(hit.uid).push(sub);
        const key = sub + '|' + date;
        if (!slotsBy.has(key)) slotsBy.set(key, []);
        if (!slotsBy.get(key).some((s) => s.person === hit.uid)) {
          slotsBy.get(key).push({ person: hit.uid, role: null, label: null, source: 'imported' });
        }
      });
    });
  });
  const duplicates = [];
  perDate.forEach((seen, date) => {
    seen.forEach((subs, uid) => {
      if (subs.length > 1) duplicates.push({ uid, date, blocks: subs.slice().sort() });
    });
  });
  duplicates.sort((a, b) => (a.date + a.uid < b.date + b.uid ? -1 : 1));

  // תחנה שאין לה בלוק בהדבקה בכלל — **חסרה**, לא „ריקה". היא עדיין
  // נחתמת בשורה עם coverage=missing כדי שהלוח הקבוע יוכל להציג
  // „לא הוזן", והיא מדווחת לאישור מפורש.
  const present = new Set(parsed.blocks.filter((b) => b.kind === 'station')
    .map((b) => b.sub_station || stationForLabel(b.label, policy)).filter(Boolean));
  const missingStations = subKeys.filter((sub) => !present.has(sub))
    .map((sub) => ({ sub_station: sub, label: (policy.sub_stations[sub] || {}).label || sub }));

  const rows = [];
  parsed.dates.forEach((date) => {
    subKeys.forEach((sub) => {
      const spec = policy.sub_stations[sub] || {};
      const minimum = Number.isInteger(spec.minimum) ? spec.minimum : 0;
      // סדר הגיליון נשמר: מי שכתוב ראשון — ראשון (ולא מיון לפי מזהה).
      const slots = (slotsBy.get(sub + '|' + date) || []).slice();
      rows.push({
        date, station_id: stationId, sub_station: sub, label: spec.label || sub,
        rotation_group: null, minimum, slots, gaps: [], rejected_manual: [],
        coverage: present.has(sub) ? 'ready' : 'missing',
        // הקו האדום מוצג; אינו חוסם — הגיליון הוא הכרעת אדם.
        below_minimum: present.has(sub) && slots.length < minimum,
        complete: true
      });
    });
  });

  // היעדרויות.
  const absences = [];
  const absenceSeen = new Set();
  parsed.blocks.forEach((block) => {
    if (block.kind !== 'absence' || !block.absence) return;
    Object.keys(block.cells).forEach((date) => {
      block.cells[date].forEach((name) => {
        const hit = resolveName(index, name);
        if (hit.ignored) { skipped += 1; return; }
        if (!hit.uid) { noteUnresolved(name, date, hit.candidates); return; }
        const key = date + '|' + hit.uid + '|' + block.absence.kind + '|' + (block.absence.location || '');
        if (absenceSeen.has(key)) return;
        absenceSeen.add(key);
        const entry = { date, uid: hit.uid, kind: block.absence.kind };
        if (block.absence.kind === 'leave' && block.absence.location) entry.location = block.absence.location;
        absences.push(entry);
      });
    });
  });
  absences.sort((a, b) => ((a.date + a.uid + a.kind) < (b.date + b.uid + b.kind) ? -1 : 1));
  const absenceCoverage = {};
  ABSENCE_KINDS.forEach((kind) => {
    absenceCoverage[kind] = parsed.blocks.some((block) => block.kind === 'absence'
      && block.absence && block.absence.kind === kind) ? 'ready' : 'missing';
  });

  const unresolvedList = Array.from(unresolved.values()).map((u) => ({
    name: u.name, count: u.count, dates: Array.from(u.dates).sort(), candidates: u.candidates
  })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  const ignored = parsed.blocks.filter((b) => b.kind === 'ignored' && b.names > 0)
    .map((b) => ({ label: b.label || '', rows: b.rows, names: b.names }));

  return Object.freeze({
    month: parsed.month,
    rows: Object.freeze(rows),
    absences: Object.freeze(absences),
    unresolved: Object.freeze(unresolvedList),
    duplicates: Object.freeze(duplicates),
    ignored: Object.freeze(ignored),
    missing_stations: Object.freeze(missingStations),
    absence_coverage: Object.freeze(absenceCoverage),
    warnings: Object.freeze((parsed.warnings || []).filter((w) => w.code === 'cell-too-many-names')),
    counts: Object.freeze({
      days: parsed.dates.length,
      stations: subKeys.length,
      assignments: rows.reduce((n, r) => n + r.slots.length, 0),
      absences: absences.length,
      unresolved: unresolvedList.reduce((n, u) => n + u.count, 0),
      duplicates: duplicates.length,
      missing_stations: missingStations.length,
      ignored_names: ignored.reduce((n, b) => n + b.names, 0),
      oversized_cells: (parsed.warnings || []).filter((w) => w.code === 'cell-too-many-names').length,
      skipped,
      below_minimum: rows.filter((r) => r.below_minimum).length
    })
  });
}

module.exports = Object.freeze({
  SheetImportError,
  ABSENCE_KINDS,
  LOCATIONS,
  MAX_CELLS,
  MAX_ROWS,
  MAX_CELL_CHARS,
  CANONICAL_STATIONS,
  CANONICAL_STATION_LABELS,
  CANONICAL_STATION_MINIMUMS,
  projectCanonicalPolicy,
  normalizeGrid,
  normText,
  absenceLabel,
  stationForLabel,
  parseDateCell,
  namesInCell,
  parseSheet,
  resolveSheet
});
