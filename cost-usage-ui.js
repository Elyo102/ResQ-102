// לוח עלות ושימוש — ציור DOM טהור. textContent בלבד.
// «אין מקור» לעולם אינו 0. תגיות שיוך אינן חשבונית. אין UID גולמי.

const UNAVAILABLE = 'לא זמין';
const NO_SOURCE = 'אין מקור';
const DAY_OPTIONS = Object.freeze([1, 7, 14, 30]);

function text(el, value) { if (el) el.textContent = String(value == null ? '' : value); }
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}
function dayText(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day)
    ? day.slice(8, 10) + '.' + day.slice(5, 7) + '.' + day.slice(0, 4)
    : '—';
}
function dateTimeText(iso) {
  if (typeof iso !== 'string' || !iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Intl.DateTimeFormat('he-IL', {
      timeZone:'Asia/Jerusalem',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).format(new Date(ms));
  } catch (ignore) {
    return iso;
  }
}
function fmtCount(n) {
  return Number.isSafeInteger(n) && n >= 0 ? new Intl.NumberFormat('he-IL').format(n) : null;
}

export function createCostUsageUi({ elements, call, currentIdentity, onIdentityLost }) {
  if (!elements || typeof call !== 'function' || typeof currentIdentity !== 'function') {
    throw new TypeError('cost-usage ui dependencies required');
  }
  let generation = 0;
  let busy = false;
  let days = 7;
  let pageToken = null;
  let nextPageToken = null;
  let stationDay = null;
  let stationPageToken = null;
  let nextStationPageToken = null;

  function sameIdentity(before) {
    const now = currentIdentity();
    return !!before && !!now && before.uid === now.uid && before.epoch === now.epoch && before.super === true && now.super === true;
  }
  function setBusy(value) {
    busy = value === true;
    [elements.refresh, elements.range, elements.nextPage, elements.stationDay,
      elements.nextStationPage].forEach((control) => { if (control) control.disabled = busy; });
  }
  function message(value, kind) {
    if (!elements.message) return;
    elements.message.className = 'cu-note ' + (kind || '');
    text(elements.message, value);
  }
  function invalidate() {
    generation += 1;
    setBusy(false);
    text(elements.measurement, '—');
    text(elements.attribution, '—');
    text(elements.rangeLabel, '—');
    if (elements.actual) elements.actual.replaceChildren();
    if (elements.load) elements.load.replaceChildren();
    if (elements.stationCalls) elements.stationCalls.replaceChildren();
    if (elements.users) elements.users.replaceChildren();
    nextPageToken = null;
    pageToken = null;
    stationPageToken = null;
    nextStationPageToken = null;
    if (elements.nextPage) elements.nextPage.classList.add('cu-hidden');
    if (elements.nextStationPage) elements.nextStationPage.classList.add('cu-hidden');
    if (elements.flags) elements.flags.replaceChildren();
    message('', '');
  }

  function badge(kind, label) {
    return el('span', 'cu-badge ' + kind, label);
  }

  function renderActual(pane) {
    if (!elements.actual) return;
    elements.actual.replaceChildren();
    const card = el('article', 'cu-row');
    const available = pane && pane.available === true
      && typeof pane.value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(pane.value)
      && typeof pane.currency === 'string' && /^[A-Z]{3}$/.test(pane.currency);
    card.dataset.available = available ? 'true' : 'false';
    const head = el('div', 'cu-row-head');
    head.appendChild(el('span', 'cu-label', available
      ? 'עלות שימוש מדווחת' : 'סיכום עלות בפועל'));
    const badges = el('span', 'cu-badges');
    badges.appendChild(badge(available ? 'actual' : 'nosource',
      available ? ((pane && pane.badge) || 'BILLING REPORTED') : NO_SOURCE));
    head.appendChild(badges);
    const value = el('strong', 'cu-value', available
      ? pane.value + ' ' + pane.currency : NO_SOURCE);
    const asOf = available && pane.as_of ? ' · עדכון ייצוא: ' + dateTimeText(pane.as_of) : '';
    const meta = el('div', 'cu-meta', ((pane && pane.note_he) || '') + asOf);
    card.append(head, value, meta);
    elements.actual.appendChild(card);
    if (available && Array.isArray(pane.by_service)) {
      const list = el('div', 'cu-list');
      for (const row of pane.by_service) {
        const item = el('div', 'cu-row');
        item.appendChild(el('span', 'cu-label', row.service || 'שירות'));
        item.appendChild(el('strong', 'cu-value', String(row.value) + ' ' + pane.currency));
        list.appendChild(item);
      }
      elements.actual.appendChild(list);
    }
  }

  function renderLoad(pane) {
    if (!elements.load) return;
    elements.load.replaceChildren();
    const intro = el('div', 'cu-note warn');
    intro.textContent = (pane && pane.partial_note_he) || 'עומס חלקי בלבד — אינו חשבונית.';
    elements.load.appendChild(intro);
    if (elements.loadLegend && pane && Array.isArray(pane.badges_legend)) {
      elements.loadLegend.replaceChildren();
      for (const b of pane.badges_legend) {
        elements.loadLegend.appendChild(badge(b.id === 'actual' ? 'actual' : (b.id === 'estimated' ? 'estimated' : 'partial'), b.label_he));
      }
    }
    const list = el('div', 'cu-list');
    const features = pane && Array.isArray(pane.features) ? pane.features : [];
    for (const f of features) {
      const row = el('article', 'cu-row');
      row.dataset.available = f.available === true ? 'true' : 'false';
      const head = el('div', 'cu-row-head');
      head.appendChild(el('span', 'cu-label', f.label_he || f.feature));
      const badges = el('span', 'cu-badges');
      badges.appendChild(badge(f.available ? 'estimated' : 'partial', f.badge || 'עומס חלקי/לא נמדד'));
      head.appendChild(badges);
      const shown = f.available === true ? fmtCount(f.count) : null;
      const value = el('strong', 'cu-value', shown === null ? UNAVAILABLE : shown);
      const meta = el('div', 'cu-meta', 'מקור: metrics_daily · אינו חשבונית');
      row.append(head, value, meta);
      list.appendChild(row);
    }
    elements.load.appendChild(list);
  }

  function renderUsers(pane) {
    if (!elements.users) return;
    elements.users.replaceChildren();
    const cov = el('div', 'cu-note');
    const start = pane && pane.measurement_start_at ? dayText(pane.measurement_start_at) : 'לא הופעלה';
    const locked = pane && pane.locked_start ? dayText(pane.locked_start) : start;
    cov.textContent = 'תחילת מדידה (נעולה): ' + locked + ' · כיסוי: ' + ((pane && pane.coverage) || 'not_started') +
      ' · שיוך: ' + ((pane && pane.attribution_status) || '—');
    elements.users.appendChild(cov);
    if (pane && pane.feeder_status === 'not_wired') {
      const feeder = el('div', 'cu-note warn');
      feeder.textContent = 'מזין לא מחובר — אין ספירות קריאות חיות (לא אפסים מזויפים).';
      elements.users.appendChild(feeder);
    } else if (pane && pane.feeder_status) {
      const feeder = el('div', 'cu-note warn');
      feeder.textContent = pane.feeder_status === 'active_partial'
        ? 'מדידה חלקית: רק שלוש קריאות שרת מוגדרות. שאר הפיצ׳רים אינם כלולים בספירה.'
        : pane.feeder_status === 'blocked' ? 'אירועי מדידה חסומים ודורשים טיפול מפעיל.'
          : pane.feeder_status === 'backlog' ? 'תור המדידה עמוס; הספירות מתעדכנות באיחור.'
            : pane.feeder_status === 'awaiting_sample' ? 'המזין פועל, אך טרם נקלט אירוע שמוכיח מדידה.'
              : 'עיבוד האירועים מתעכב; אין להניח שהספירות עדכניות.';
      elements.users.appendChild(feeder);
    }
    const table = el('div', 'cu-users');
    const head = el('div', 'cu-user cu-user-head');
    head.append(
      el('span', null, 'שם'),
      el('span', null, 'תחנה'),
      el('span', null, 'כניסה אחרונה'),
      el('span', null, 'קריאות מאז מדידה')
    );
    table.appendChild(head);
    const rows = pane && Array.isArray(pane.users) ? pane.users : [];
    for (const u of rows) {
      const row = el('div', 'cu-user');
      row.appendChild(el('span', null, u.display_name || '—'));
      row.appendChild(el('span', null, u.station_id || '—'));
      row.appendChild(el('span', null, u.last_signin ? dateTimeText(String(u.last_signin)) : '—'));
      let callsText = UNAVAILABLE;
      if (u.call_count_coverage === 'since_measurement_start' && Number.isSafeInteger(u.call_count)) {
        callsText = fmtCount(u.call_count);
      } else if (u.call_count_coverage === 'not_started') {
        callsText = 'מדידה לא הופעלה';
      } else if (u.call_count_coverage === 'attribution_disabled') {
        callsText = 'שיוך מושבת';
      } else {
        callsText = 'לא נמדד';
      }
      row.appendChild(el('span', null, callsText));
      table.appendChild(row);
    }
    if (!rows.length) table.appendChild(el('div', 'cu-meta', 'אין משתמשים להצגה.'));
    elements.users.appendChild(table);
    if (pane && pane.note_he) elements.users.appendChild(el('div', 'cu-note', pane.note_he));
    nextPageToken = pane && typeof pane.next_page_token === 'string' ? pane.next_page_token : null;
    if (elements.nextPage) {
      if (nextPageToken) elements.nextPage.classList.remove('cu-hidden');
      else elements.nextPage.classList.add('cu-hidden');
    }
  }

  function renderStationCalls(pane) {
    if (!elements.stationCalls) return;
    elements.stationCalls.replaceChildren();
    const intro = el('div', 'cu-note warn', pane && pane.note_he || 'מדידת תחנות אינה זמינה.');
    elements.stationCalls.appendChild(intro);
    if (pane && Array.isArray(pane.measured_callables) && pane.measured_callables.length) {
      elements.stationCalls.appendChild(el('div', 'cu-meta',
        'הפעולות הנספרות בלבד: ' + pane.measured_callables.join(', ') + '. קריאות אחרות אינן כלולות.'));
    }
    if (!pane || pane.status === 'not_started') {
      elements.stationCalls.appendChild(el('div', 'cu-note', 'צבירה לפי תחנה טרם הופעלה. אין היסטוריה מומצאת.'));
      return;
    }
    if (pane.status !== 'partial') {
      elements.stationCalls.appendChild(el('div', 'cu-note warn',
        pane.status === 'overflow' ? 'טווח גדול מדי; לא מוצג סכום חלקי.' : 'נתוני המונה אינם תקינים; לא מוצג סכום.'));
      return;
    }
    elements.stationCalls.appendChild(el('div', 'cu-meta',
      'תחילת צבירה: ' + dateTimeText(pane.station_aggregate_start_at) +
      ' · תחילת סך כללי: ' + dateTimeText(pane.global_aggregate_start_at) +
      ' · עיבוד אחרון: ' + dateTimeText(pane.last_ingested_at) + ' · כיסוי חלקי בלבד'));
    for (const day of pane.days || []) {
      const card = el('article', 'cu-row');
      const head = el('div', 'cu-row-head');
      head.appendChild(el('span', 'cu-label', dayText(day.day)));
      head.appendChild(el('strong', 'cu-value', day.total === null ? 'לא נמדד' :
        fmtCount(day.total) + (day.coverage === 'partial_start_day' ? ' קריאות מאז תחילת המדידה ביום זה (חלקי)' : ' קריאות נמדדות בסך הכול')));
      card.appendChild(head);
      const stations = el('div', 'cu-list');
      for (const station of day.stations || []) {
        const row = el('div', 'cu-row');
        row.appendChild(el('span', 'cu-label', station.station_id));
        row.appendChild(el('strong', 'cu-value', station.calls === null ? 'לא נמדד' : fmtCount(station.calls)));
        stations.appendChild(row);
      }
      if (!day.stations || !day.stations.length) stations.appendChild(el('div', 'cu-meta',
        day.coverage === 'before_start' ? 'לפני תחילת המדידה התחנתית' : 'אין קריאה נמדדת לתחנה ביום זה'));
      card.appendChild(stations);
      card.appendChild(el('div', 'cu-meta', 'מוצג עמוד תחנות רשומות; הסך הכללי כולל גם תחנות היסטוריות.'));
      elements.stationCalls.appendChild(card);
    }
    nextStationPageToken = pane.next_station_page_token || null;
    if (elements.nextStationPage) elements.nextStationPage.classList.toggle('cu-hidden', !nextStationPageToken);
  }

  function render(dto) {
    const d = dto && typeof dto === 'object' ? dto : {};
    const m = d.measurement || {};
    text(elements.measurement, m.status === 'active'
      ? ('פעילה מאז ' + dayText(m.measurement_start_at) + (m.locked ? ' (נעולה)' : ''))
      : 'לא הופעלה');
    const a = d.attribution || {};
    text(elements.attribution, a.ready === true ? 'HMAC מוכן' : 'שיוך מושבת (אין מפתח)');
    text(elements.rangeLabel, Number.isSafeInteger(d.days) ? (d.days + ' ימים') : '—');
    if (elements.flags) {
      elements.flags.replaceChildren();
      elements.flags.appendChild(badge('partial', 'עומס חלקי'));
      const actual = d.panes && d.panes.actual_cost;
      const hasActual = actual && actual.available === true
        && typeof actual.value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(actual.value)
        && typeof actual.currency === 'string' && /^[A-Z]{3}$/.test(actual.currency);
      elements.flags.appendChild(badge(hasActual ? 'actual' : 'nosource',
        hasActual ? 'עלות שימוש מדווחת' : 'עלות בפועל: אין מקור'));
      if (a.ready !== true) elements.flags.appendChild(badge('warn', 'HMAC חסר'));
      const feeder = d.feeder || {};
      if (feeder.status === 'not_wired') elements.flags.appendChild(badge('warn', 'מזין לא מחובר'));
      else if (feeder.status === 'active_partial') elements.flags.appendChild(badge('warn', 'מדידה חלקית'));
      else if (feeder.status === 'awaiting_sample') elements.flags.appendChild(badge('warn', 'ממתין לדגימת מדידה'));
      else if (feeder.status === 'blocked') elements.flags.appendChild(badge('warn', 'אירועים חסומים'));
      else elements.flags.appendChild(badge('warn', 'מדידה מתעכבת'));
    }
    renderActual(d.panes && d.panes.actual_cost);
    renderLoad(d.panes && d.panes.load_attribution);
    const stationPane = d.panes && d.panes.station_calls;
    if (stationPane && /^\d{4}-\d{2}-\d{2}$/.test(stationPane.selected_day || '')) {
      stationDay = stationPane.selected_day;
      if (elements.stationDay) elements.stationDay.value = stationDay;
    }
    renderStationCalls(stationPane);
    renderUsers(d.panes && d.panes.users);
    if (elements.selfCost) {
      const note = d.self_cost_note_he || '';
      const feederNote = (d.feeder && d.feeder.note_he) ? (' ' + d.feeder.note_he) : '';
      text(elements.selfCost, note + feederNote);
    }
  }

  async function refresh() {
    if (busy) return;
    const before = currentIdentity();
    const mine = ++generation;
    setBusy(true);
    try {
      const payload = { days };
      if (stationDay) payload.stationDay = stationDay;
      if (pageToken) payload.pageToken = pageToken;
      if (stationPageToken) payload.stationPageToken = stationPageToken;
      const result = await call('getCostUsageDashboard', payload);
      if (mine !== generation) return;
      if (!sameIdentity(before)) { onIdentityLost(); return; }
      render(result || {});
      message('הנתונים עודכנו. עלות בפועל נפרדת משיוך משוער.', 'safe');
    } catch (error) {
      if (mine !== generation) return;
      if (!sameIdentity(before)) { onIdentityLost(); return; }
      const code = String(error && error.code || '');
      message(code.includes('permission-denied')
        ? 'השרת דחה: נדרשת הרשאת מנהל-על חיה (לא saas-admin).'
        : 'הטעינה נכשלה. ' + (code || 'שגיאה'), 'warn');
    } finally {
      if (mine === generation) setBusy(false);
    }
  }

  function setDays(value) {
    const n = Number(value);
    days = DAY_OPTIONS.includes(n) ? n : 7;
    pageToken = null;
    return days;
  }
  async function nextPage() {
    if (!nextPageToken || busy) return;
    pageToken = nextPageToken;
    await refresh();
  }
  function setStationDay(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) stationDay = value;
    stationPageToken = null;
    nextStationPageToken = null;
    return stationDay;
  }
  async function nextStationPage() {
    if (!nextStationPageToken || busy) return;
    stationPageToken = nextStationPageToken;
    await refresh();
  }
  function resetPaging() { pageToken = null; nextPageToken = null; }

  return Object.freeze({ render, invalidate, refresh, setDays, setStationDay,
    nextPage, nextStationPage, resetPaging, days: () => days });
}

export const COST_USAGE_DAY_OPTIONS = DAY_OPTIONS;
export const COST_USAGE_NO_SOURCE = NO_SOURCE;
export const COST_USAGE_UNAVAILABLE = UNAVAILABLE;
