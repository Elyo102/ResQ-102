const OPEN_LIMIT = 24;
const GROUPS = Object.freeze(['operational', 'building']);
let active = null;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function groupOf(row) {
  return row && row.kind === 'building' ? 'building' : 'operational';
}

function normalize(doc) {
  const row = doc && typeof doc.data === 'function' ? doc.data() : null;
  if (!row || row.status !== 'open') return null;
  const title = text(row.title).slice(0, 80);
  if (!title) return null;
  return Object.freeze({
    id: text(doc.id),
    group: groupOf(row),
    title,
    subject: text(row.vehicle_name).slice(0, 80),
    date: text(row.date).slice(0, 10),
    severity: ['critical', 'major', 'minor'].includes(row.severity) ? row.severity : 'unset'
  });
}

function make(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (value) el.textContent = value;
  return el;
}

function render(session) {
  if (active !== session) return;
  const selected = GROUPS.includes(session.selected) ? session.selected : 'operational';
  const rows = session.rows.filter((row) => row.group === selected);
  session.elements.list.replaceChildren();
  session.elements.empty.classList.toggle('hide', rows.length !== 0);
  rows.slice(0, 6).forEach((row) => {
    const card = make('a', 'home-fault-card');
    card.href = './faults.html';
    card.dataset.severity = row.severity;
    const heading = make('strong', 'home-fault-title', row.title);
    const meta = make('span', 'home-fault-meta');
    meta.textContent = [row.subject, row.date].filter(Boolean).join(' · ') || 'תקלה פתוחה';
    card.append(heading, meta);
    session.elements.list.appendChild(card);
  });
  const counts = { operational:0, building:0 };
  session.rows.forEach((row) => { counts[row.group] += 1; });
  session.elements.operationalCount.textContent = String(counts.operational);
  session.elements.buildingCount.textContent = String(counts.building);
  session.elements.tabs.forEach((tab) => {
    const on = tab.dataset.faultGroup === selected;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  session.elements.status.textContent = session.partial
    ? 'מוצגות התקלות האחרונות. הרשימה המלאה זמינה במסך התקלות.' : '';
}

export function destroyHomeFaults() {
  const prior = active;
  active = null;
  if (prior && typeof prior.unsubscribe === 'function') prior.unsubscribe();
  if (prior) {
    prior.rows = [];
    prior.elements.list.replaceChildren();
    prior.elements.status.textContent = '';
  }
}

export function initHomeFaults(options) {
  destroyHomeFaults();
  const { db, user, stationId, sdk, elements } = options || {};
  if (!db || !user || !text(user.uid) || !text(stationId) || !sdk || !elements) {
    throw new Error('home-faults-invalid-options');
  }
  const required = ['collection', 'query', 'where', 'orderBy', 'limit', 'onSnapshot'];
  required.forEach((name) => { if (typeof sdk[name] !== 'function') throw new Error('home-faults-missing-' + name); });
  const session = { uid:user.uid, stationId, rows:[], selected:'operational', partial:false, elements, unsubscribe:null };
  active = session;
  elements.tabs.forEach((tab) => {
    tab.onclick = () => {
      if (active !== session || !GROUPS.includes(tab.dataset.faultGroup)) return;
      session.selected = tab.dataset.faultGroup;
      render(session);
    };
  });
  elements.status.textContent = 'טוען תקלות פתוחות…';
  const source = sdk.query(
    sdk.collection(db, 'stations', stationId, 'faults'),
    sdk.where('status', '==', 'open'),
    sdk.orderBy('created_key', 'desc'),
    sdk.limit(OPEN_LIMIT)
  );
  session.unsubscribe = sdk.onSnapshot(source, (snapshot) => {
    if (active !== session) return;
    const docs = snapshot && Array.isArray(snapshot.docs) ? snapshot.docs : [];
    session.rows = docs.map(normalize).filter(Boolean);
    session.partial = docs.length === OPEN_LIMIT;
    render(session);
  }, () => {
    if (active !== session) return;
    session.rows = [];
    render(session);
    elements.status.textContent = 'לא הצלחנו לטעון תקלות כרגע. אפשר לפתוח את מסך התקלות ולנסות שוב.';
  });
  return Object.freeze({ destroy:() => { if (active === session) destroyHomeFaults(); } });
}

export const HOME_FAULT_GROUPS = GROUPS;
export const HOME_FAULT_LIMIT = OPEN_LIMIT;
