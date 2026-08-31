/* eslint-env browser */
/**
 * schedule-planner.js — מסכי ניהול סידור עבודה.
 *
 * שלושה מסכים על אותם נתונים:
 *   ניהול   — לאחראי הסידור ולקצינים מורשים.
 *   שלי     — הסידור האישי של הכבאי.
 *   התחנה   — כלל התחנה, עם היום שלפני ואחרי.
 *
 * המסך אינו הרשאה. מתג התפקיד כאן הוא להדגמה בלבד;
 * האכיפה האמיתית ב-functions/schedule-service.js ונבדקת שם.
 *
 * הנתונים ב-DATA הופקו על ידי functions/schedule-calendar-engine.js
 * ואינם כתובים ביד.
 */
(function () {
  'use strict';

  var DATA = window.RESQ_FIXTURE;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  };

  /* ---------------- מצב ---------------- */
  var state = {
    view: 'manage',            // manage | mine | station
    role: 'scheduler',         // scheduler | firefighter
    me: 'כבאי 001',
    dayIndex: 3,
    months: 1,
    published: false,
    tab: 'eilat'
  };

  // מסך הסידור אינו חושף סיבת היעדרות. כל הסיבות מתאחדות לסטטוס ניטרלי.
  var ABS_ROWS = [
    { key: 'unavailable', label: 'לא זמין', tint: 'sick' }
  ];

  var unconfirmed = {};
  (DATA.unconfirmed || []).forEach(function (n) { unconfirmed[n] = true; });

  /* ---------------- אינדוקס התוכנית ---------------- */
  var byDateSub = {};
  DATA.plan.rows.forEach(function (r) {
    byDateSub[r.date + '|' + r.sub_station] = r;
  });
  function cell(date, sub) { return byDateSub[date + '|' + sub] || null; }

  function myDays(person) {
    var out = [];
    DATA.plan.rows.forEach(function (r) {
      r.slots.forEach(function (s) {
        if (s.person !== person) return;
        out.push({
          date: r.date, sub: r.sub_station, label: r.label,
          role_label: s.label, rotation: r.rotation_group,
          crew: r.slots.filter(function (x) { return x.person !== person; })
            .map(function (x) { return { person: x.person, role_label: x.label }; })
        });
      });
    });
    out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return out;
  }
  function myEvents(person) {
    return (DATA.events || []).filter(function (e) { return e.people.indexOf(person) > -1; });
  }

  /* ---------------- מסך הניהול ---------------- */

  function renderSetup() {
    var reqs = DATA.requirements[state.tab] || [];
    var h = '<h2>חוקיות התחנה</h2>'
      + '<p class="lead">כמה אנשים בכל תפקיד דרושים ביום, וקו המינימום של תחנת הקצה. '
      + 'ערכים אלה הם מדיניות שהתחנה מזינה — המנוע אינו מניח אותם.</p><div class="tabs">';
    DATA.sub_order.forEach(function (k) {
      h += '<button class="' + (state.tab === k ? 'on' : '') + '" data-tab="' + k + '">'
        + esc(DATA.labels[k]) + '</button>';
    });
    h += '</div><div class="reqs">';
    reqs.forEach(function (r) {
      h += '<div class="req"><span class="lb">' + esc(r.label)
        + (r.required ? '' : ' <small>(רשות)</small>') + '</span>'
        + '<span class="stp"><button data-req="' + esc(r.role) + '" data-d="-1">−</button>'
        + '<b data-count="' + esc(r.role) + '">' + r.count + '</b>'
        + '<button data-req="' + esc(r.role) + '" data-d="1">+</button></span></div>';
    });
    h += '<div class="req min"><span class="lb">קו מינימום</span>'
      + '<span class="stp"><button data-min="-1">−</button><b id="minVal">'
      + DATA.minimums[state.tab] + '</b><button data-min="1">+</button></span></div>';
    h += '</div><div class="run">'
      + '<button class="pri big" id="go">⚡ בצע שיבוץ אוטומטי</button>'
      + '<span class="muted">להכין קדימה</span><span class="seg">'
      + [1, 2, 3].map(function (m) {
        return '<button class="' + (state.months === m ? 'on' : '') + '" data-months="' + m + '">'
          + (m === 1 ? 'חודש' : m === 2 ? 'חודשיים' : 'שלושה') + '</button>';
      }).join('') + '</span>'
      + '<span class="tot">תחנת קצה: <b>' + esc(DATA.labels[state.tab]) + '</b></span></div>';
    $('setup').innerHTML = h;

    Array.prototype.forEach.call($('setup').querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { state.tab = b.getAttribute('data-tab'); renderSetup(); };
    });
    Array.prototype.forEach.call($('setup').querySelectorAll('[data-months]'), function (b) {
      b.onclick = function () { state.months = +b.getAttribute('data-months'); renderSetup(); };
    });
    Array.prototype.forEach.call($('setup').querySelectorAll('[data-req]'), function (b) {
      b.onclick = function () {
        var role = b.getAttribute('data-req');
        var d = +b.getAttribute('data-d');
        var row = (DATA.requirements[state.tab] || []).filter(function (x) { return x.role === role; })[0];
        if (!row) return;
        row.count = Math.max(0, row.count + d);
        renderSetup();
      };
    });
    Array.prototype.forEach.call($('setup').querySelectorAll('[data-min]'), function (b) {
      b.onclick = function () {
        DATA.minimums[state.tab] = Math.max(0, DATA.minimums[state.tab] + (+b.getAttribute('data-min')));
        renderSetup(); renderBoard();
      };
    });
    $('go').onclick = function () {
      $('runNote').hidden = false;
      $('runNote').textContent = 'הורצה טיוטה ל'
        + (state.months === 1 ? 'חודש' : state.months === 2 ? 'חודשיים' : 'שלושה חודשים')
        + ' · איש לא קיבל התראה.';
    };
  }

  function nameLine(personName, extraClass) {
    return '<div class="n' + (extraClass ? ' ' + extraClass : '') + '">'
      + esc(personName)
      + (unconfirmed[personName] ? ' <span class="q" title="טרם אישר">?</span>' : '')
      + '</div>';
  }

  function renderBoard() {
    var days = DATA.days;
    var h = '<div class="hd corner"></div>';
    days.forEach(function (d) {
      var dt = new Date(d + 'T00:00:00Z');
      var wd = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][dt.getUTCDay()];
      h += '<div class="hd"><span class="wd">' + wd + '</span>'
        + dt.getUTCDate() + '/' + (dt.getUTCMonth() + 1) + '</div>';
    });

    DATA.sub_order.forEach(function (sub) {
      h += '<div class="rowlab tint-' + sub + '">' + esc(DATA.labels[sub]) + '</div>';
      days.forEach(function (date) {
        var c = cell(date, sub);
        h += '<div class="cell tint-' + sub + '" data-cell="' + date + '|' + sub + '">';
        if (!c) { h += '<span class="dash">—</span></div>'; return; }
        var minLine = DATA.minimums[sub];
        var ord = c.slots.slice().sort(function (a, b) {
          var ka = a.source === 'manual' ? 0 : 1;
          var kb = b.source === 'manual' ? 0 : 1;
          return ka - kb;
        });
        ord.forEach(function (s, i) {
          if (i === minLine && i < ord.length) h += '<div class="rule"></div>';
          h += nameLine(s.person, s.person === state.me ? 'me' : '');
        });
        var short = c.gaps.filter(function (g) { return g.required; }).length;
        if (short) h += '<div class="gap">חסרים ' + short + '</div>';
        if (c.below_minimum) h += '<div class="gap under">מתחת לקו · ' + ord.length + '/' + minLine + '</div>';
        h += '</div>';
      });
    });

    // משימות ואירועים
    h += '<div class="rowlab tint-task">משימות</div>';
    days.forEach(function (date) {
      var evs = (DATA.events || []).filter(function (e) { return e.date === date; });
      h += '<div class="cell tint-task">';
      evs.forEach(function (e) {
        h += '<div class="blk k-' + esc(e.kind) + '"><b>' + esc(e.title) + '</b>'
          + '<span>' + esc(e.sub) + '</span><time>' + esc(e.hours) + '</time></div>';
      });
      h += '</div>';
    });

    ABS_ROWS.forEach(function (r) {
      h += '<div class="rowlab tint-' + r.tint + '">' + esc(r.label) + '</div>';
      days.forEach(function (date) {
        var list = (DATA.absence_rows[r.key] || {})[date] || [];
        h += '<div class="cell tint-' + r.tint + '">'
          + list.map(function (n) { return nameLine(n, n === state.me ? 'me' : ''); }).join('')
          + '</div>';
      });
    });

    $('grid').style.gridTemplateColumns = '7.4rem repeat(' + days.length + ', minmax(9rem, 1fr))';
    $('grid').innerHTML = h;
  }

  function renderFindings() {
    var s = DATA.plan.summary;
    var h = '<div class="kpis">'
      + '<div class="kpi ok"><b>' + s.filled + '</b><small>תפקידים שובצו</small></div>'
      + '<div class="kpi ' + (s.blocking_gaps ? 'bad' : 'ok') + '"><b>' + s.blocking_gaps
      + '</b><small>תקנים לא אוישו</small></div>'
      + '<div class="kpi ' + (s.days_below_minimum ? 'bad' : 'ok') + '"><b>' + s.days_below_minimum
      + '</b><small>משבצות מתחת לקו</small></div>'
      + '<div class="kpi"><b>' + s.fairness.spread + '</b><small>פער עומס</small></div></div>';
    var open = DATA.plan.rows.filter(function (r) { return !r.complete; });
    if (!open.length) {
      h += '<div class="clean">✓ אין משבצות פתוחות</div>';
    } else {
      open.slice(0, 6).forEach(function (r) {
        var why = r.below_minimum ? 'מתחת לקו המינימום'
          : r.gaps.filter(function (g) { return g.required; })
            .map(function (g) { return 'חסר ' + g.label; }).join(' · ');
        h += '<div class="fnd"><span class="tag">' + esc(r.label) + '</span>'
          + '<span class="day">' + esc(r.date) + '</span><span>' + esc(why) + '</span></div>';
      });
      if (open.length > 6) h += '<div class="muted">ועוד ' + (open.length - 6) + '</div>';
    }
    h += '<div class="note">זו <b>טיוטה</b>. רק לחיצה על <b>פרסום</b> שולחת התראה למישהו.</div>';
    $('findings').innerHTML = h;
  }

  /* ---------------- הסידור שלי ---------------- */

  function heDate(iso) {
    var dt = new Date(iso + 'T00:00:00Z');
    var wd = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][dt.getUTCDay()];
    return 'יום ' + wd + ' · ' + dt.getUTCDate() + '/' + (dt.getUTCMonth() + 1);
  }

  function renderMine() {
    var date = DATA.days[state.dayIndex];
    var mine = myDays(state.me).filter(function (d) { return d.date === date; });
    var evs = myEvents(state.me).filter(function (e) { return e.date === date; });
    var quals = DATA.qualifications[state.me] || [];

    var h = '<div class="dayNav">'
      + '<button class="nav" id="prevDay" aria-label="יום קודם">›</button>'
      + '<div class="t"><b>' + heDate(date) + '</b><small>' + date + '</small></div>'
      + '<button class="nav" id="nextDay" aria-label="יום הבא">‹</button></div><div class="cards">';

    if (!mine.length && !evs.length) {
      h += '<div class="card empty">אינך משובץ ביום זה</div>';
    }
    mine.forEach(function (d) {
      h += '<div class="card tint-' + d.sub + '">'
        + '<div class="ch">' + esc(d.label) + '</div>'
        + '<div class="cb"><div class="who"><span class="av">'
        + esc(state.me.slice(0, 2)) + '</span><span class="nm">' + esc(state.me)
        + '<small>' + esc(d.role_label || '') + (d.rotation ? ' · סבב ' + esc(d.rotation) : '') + '</small></span></div>'
        + '<div class="chips">' + quals.map(function (q) { return '<span class="chip">' + esc(q) + '</span>'; }).join('') + '</div>'
        + '<div class="crew">צוות: ' + esc(d.crew.slice(0, 8).map(function (c) { return c.person; }).join(' · ')) + '</div>'
        + (state.published
          ? '<div class="chg">שינוי בסידור שלך · שינה: <b>אחראי הסידור</b> · היום 14:12</div>'
            + '<div class="acts"><button class="ok">מאשר</button>'
            + '<button class="no">לא יכול · בנימוק</button></div>'
          : '<div class="state ok">אישרתי ✓</div>')
        + '</div></div>';
    });
    evs.forEach(function (e) {
      h += '<div class="card tint-task"><div class="ch">' + esc(e.title) + '</div>'
        + '<div class="cb"><b>' + esc(e.sub) + '</b><div class="hours">' + esc(e.hours) + '</div>'
        + '<div class="state warn">ממתין לאישורך ⚠</div>'
        + '<div class="acts"><button class="ok">מאשר</button>'
        + '<button class="no">לא יכול · בנימוק</button></div></div></div>';
    });
    h += '</div>';
    $('mine').innerHTML = h;
    $('prevDay').onclick = function () { if (state.dayIndex > 0) { state.dayIndex -= 1; render(); } };
    $('nextDay').onclick = function () {
      if (state.dayIndex < DATA.days.length - 1) { state.dayIndex += 1; render(); }
    };
  }

  /* ---------------- סידור התחנה ---------------- */

  function dayColumn(date, title) {
    var h = '<div class="dayCol"><div class="dayHead">' + esc(title) + '<small>' + esc(date) + '</small></div>';
    DATA.sub_order.forEach(function (sub) {
      var c = cell(date, sub);
      h += '<div class="stBlock tint-' + sub + '"><div class="stLab">' + esc(DATA.labels[sub]) + '</div>';
      if (!c || !c.slots.length) h += '<div class="dash">—</div>';
      else {
        c.slots.forEach(function (s) {
          h += nameLine(s.person, s.person === state.me ? 'me' : '');
        });
      }
      h += '</div>';
    });
    var evs = (DATA.events || []).filter(function (e) { return e.date === date; });
    if (evs.length) {
      h += '<div class="stBlock tint-task"><div class="stLab">משימות</div>';
      evs.forEach(function (e) {
        h += '<div class="n' + (e.people.indexOf(state.me) > -1 ? ' me' : '') + '">'
          + esc(e.title) + ' · ' + esc(e.hours) + '</div>';
      });
      h += '</div>';
    }
    // תצוגת התחנה אינה מציגה מי נעדר או למה; מידע כזה שייך למסך ניהול מורשה בלבד.
    return h + '</div>';
  }

  function renderStation() {
    var i = state.dayIndex;
    var prev = i > 0 ? DATA.days[i - 1] : null;
    var next = i < DATA.days.length - 1 ? DATA.days[i + 1] : null;
    var h = '<div class="dayNav">'
      + '<button class="nav" id="prevDay2" aria-label="יום קודם">›</button>'
      + '<div class="t"><b>' + heDate(DATA.days[i]) + '</b><small>סידור התחנה</small></div>'
      + '<button class="nav" id="nextDay2" aria-label="יום הבא">‹</button></div>'
      + '<div class="threeDays">'
      + (prev ? dayColumn(prev, 'אתמול') : '')
      + dayColumn(DATA.days[i], 'היום')
      + (next ? dayColumn(next, 'מחר') : '')
      + '</div>';
    $('station').innerHTML = h;
    $('prevDay2').onclick = function () { if (state.dayIndex > 0) { state.dayIndex -= 1; render(); } };
    $('nextDay2').onclick = function () {
      if (state.dayIndex < DATA.days.length - 1) { state.dayIndex += 1; render(); }
    };
  }

  /* ---------------- ניווט ---------------- */

  function render() {
    var isManage = state.view === 'manage';
    var mayManage = state.role === 'scheduler';
    if (isManage && !mayManage) state.view = 'mine';

    $('manageWrap').hidden = state.view !== 'manage';
    $('mine').hidden = state.view !== 'mine';
    $('station').hidden = state.view !== 'station';
    $('manageTab').hidden = !mayManage;

    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === state.view);
      b.setAttribute('aria-selected', b.getAttribute('data-view') === state.view ? 'true' : 'false');
    });

    $('crumb').textContent = state.view === 'manage'
      ? 'ניהול › ניהול סידור עבודה'
      : (state.view === 'mine' ? 'סידור › הסידור שלי' : 'סידור › סידור התחנה');
    $('title').textContent = state.view === 'manage'
      ? 'ניהול סידור עבודה'
      : (state.view === 'mine' ? 'הסידור שלי' : 'סידור התחנה');

    if (state.view === 'manage') { renderSetup(); renderBoard(); renderFindings(); }
    if (state.view === 'mine') renderMine();
    if (state.view === 'station') renderStation();
  }

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
      b.onclick = function () { state.view = b.getAttribute('data-view'); render(); };
    });
    $('roleSel').onchange = function () {
      state.role = this.value;
      state.me = this.value === 'scheduler' ? 'כבאי 001' : 'כבאי 002';
      if (state.role !== 'scheduler' && state.view === 'manage') state.view = 'mine';
      render();
    };
    $('publishBtn').onclick = function () {
      state.published = true;
      $('pubState').textContent = 'פורסם · נשלחו התראות אישיות';
      $('pubState').className = 'pill ok';
      render();
    };
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
