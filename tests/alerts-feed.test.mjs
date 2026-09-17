// 42H.20 §5.4 · pure-logic unit tests for alerts-feed.js (no browser, no
// Firestore emulator needed — only the merge/filter/count helpers, which
// hold all of the feed's actual filtering logic).
import assert from 'node:assert/strict';
import { bulletinFeedItem, calloutFeedItem, mergeFeedItems, applyFeedFilter, unreadFeedCount, ALERT_FEED_FILTERS,
  resolveBulletinViewed, loadAlertsFeed } from '../alerts-feed.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

// Minimal fake Firestore SDK: `docs` is {collectionPathSuffix: [{id, data}]},
// `receipts`/`responses` are Sets of "path/id" keys that "exist". Every call
// is recorded in `calls` so tests can assert exactly what was and was not
// queried (in particular: never re-querying a board handed in via override).
function fakeSdk({ boards = [], boardMessages = {}, calloutDocs = [], receiptExists = () => false, responseSeen = () => false } = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      collection: (...parts) => ({ path: parts.slice(1).join('/') }),
      doc: (db, ...parts) => ({ path: parts.join('/') }),
      query: (base, ...clauses) => ({ path: base.path, clauses }),
      where: (field, op, value) => ({ kind: 'where', field, op, value }),
      orderBy: (field, direction) => ({ kind: 'orderBy', field, direction }),
      limit: (count) => ({ kind: 'limit', count }),
      getDoc: async (ref) => {
        calls.push({ op: 'getDoc', path: ref.path });
        if (ref.path.includes('bulletin_view_receipts')) {
          return { exists: () => receiptExists(ref.path) };
        }
        if (ref.path.includes('/responses/')) {
          const seen = responseSeen(ref.path);
          return { exists: () => seen !== undefined, data: () => ({ seen_at: seen }) };
        }
        return { exists: () => false };
      },
      getDocs: async (q) => {
        const fullPath = q.path;
        // matches the fixed test-visible id (last path segment before
        // 'bulletin_messages', or the whole thing for top-level collections)
        const shortPath = fullPath.endsWith('/bulletin_messages')
          ? fullPath.split('/').slice(-2).join('/') : fullPath.split('/').pop();
        calls.push({ op: 'getDocs', path: shortPath });
        if (shortPath === 'sub_stations') {
          return { docs: boards.map(b => ({ id: b.id, data: () => ({ name: b.name }) })) };
        }
        if (shortPath.endsWith('/bulletin_messages')) {
          const boardId = shortPath.split('/')[0];
          const rows = boardMessages[boardId] || [];
          return { docs: rows.map(r => ({ id: r.id, data: () => r.data })) };
        }
        if (shortPath === 'callouts') {
          return { docs: calloutDocs.map(r => ({ id: r.id, data: () => r.data })) };
        }
        return { docs: [] };
      }
    }
  };
}

check('ALERT_FEED_FILTERS exposes exactly the three required filters', () => {
  assert.deepEqual(ALERT_FEED_FILTERS.map(f => f.id), ['all', 'unread', 'callout']);
});

check('bulletinFeedItem and calloutFeedItem shape their kind correctly', () => {
  const b = bulletinFeedItem('crew_a', 'משמרת א', 'm1', { text: 'שלום', by_name: 'דני' }, true, 1000);
  assert.equal(b.kind, 'bulletin'); assert.equal(b.id, 'crew_a/m1'); assert.equal(b.viewed, true);
  const c = calloutFeedItem('c1', { text: 'קריאה', active: true }, false, 2000);
  assert.equal(c.kind, 'callout'); assert.equal(c.viewed, false); assert.equal(c.active, true);
});

check('mergeFeedItems sorts newest-first across both sources and caps at limit', () => {
  const bulletin = [bulletinFeedItem('b', 'ב', '1', {}, true, 100), bulletinFeedItem('b', 'ב', '2', {}, true, 300)];
  const callouts = [calloutFeedItem('c1', {}, false, 200)];
  const merged = mergeFeedItems(bulletin, callouts, 2);
  assert.deepEqual(merged.map(x => x.time_ms), [300, 200]);
  assert.equal(merged.length, 2);
});

check('applyFeedFilter("all") returns everything unfiltered', () => {
  const items = [bulletinFeedItem('b', 'ב', '1', {}, true, 1), calloutFeedItem('c', {}, false, 2)];
  assert.equal(applyFeedFilter(items, 'all').length, 2);
});

check('applyFeedFilter("unread") keeps only unviewed items regardless of kind', () => {
  const items = [
    bulletinFeedItem('b', 'ב', '1', {}, true, 1),
    bulletinFeedItem('b', 'ב', '2', {}, false, 2),
    calloutFeedItem('c1', {}, true, 3),
    calloutFeedItem('c2', {}, false, 4)
  ];
  const unread = applyFeedFilter(items, 'unread');
  assert.deepEqual(unread.map(x => x.id), ['b/2', 'c2']);
});

check('applyFeedFilter("callout") keeps only callout-kind items regardless of viewed state', () => {
  const items = [bulletinFeedItem('b', 'ב', '1', {}, false, 1), calloutFeedItem('c1', {}, true, 2), calloutFeedItem('c2', {}, false, 3)];
  const only = applyFeedFilter(items, 'callout');
  assert.deepEqual(only.map(x => x.id), ['c1', 'c2']);
});

check('unreadFeedCount is the exact same computation the bell dot and the "unread" tab both use', () => {
  const items = [bulletinFeedItem('b', 'ב', '1', {}, true, 1), bulletinFeedItem('b', 'ב', '2', {}, false, 2), calloutFeedItem('c1', {}, false, 3)];
  assert.equal(unreadFeedCount(items), applyFeedFilter(items, 'unread').length);
  assert.equal(unreadFeedCount(items), 2);
});

check('an authored bulletin message counts as viewed without needing a receipt read', () => {
  const mine = bulletinFeedItem('b', 'ב', '1', { by_uid: 'me' }, true, 1);
  assert.equal(mine.viewed, true);
});

check('mergeFeedItems tolerates missing/undefined inputs', () => {
  assert.deepEqual(mergeFeedItems(undefined, undefined, 5), []);
  assert.deepEqual(mergeFeedItems(null, [calloutFeedItem('c', {}, false, 1)], 5).length, 1);
});

// --- 42H.20 closure batch item 2/3: historical callouts in the filter, and
// the home-bell override that must never re-query a board bulletin.js
// already holds live. ---

await check('resolveBulletinViewed trusts an unread receipt read over the local heuristic', async () => {
  const { sdk } = fakeSdk({ receiptExists: () => true });
  const viewed = await resolveBulletinViewed(sdk, {}, 'rashit', 'me', { id: 'm1' }, { by_uid: 'other' });
  assert.equal(viewed, true);
});

await check('resolveBulletinViewed treats an unwritten receipt as not-yet-viewed, not an error', async () => {
  const { sdk } = fakeSdk({ receiptExists: () => false });
  const viewed = await resolveBulletinViewed(sdk, {}, 'rashit', 'me', { id: 'm1' }, {});
  assert.equal(viewed, false);
});

await check('loadAlertsFeed callout query no longer filters on active — closed callouts are included', async () => {
  const { sdk, calls } = fakeSdk({
    boards: [], boardMessages: {},
    calloutDocs: [
      { id: 'c-open', data: { text: 'פתוחה', active: true, created_key: 2 } },
      { id: 'c-closed', data: { text: 'סגורה', active: false, created_key: 1 } }
    ]
  });
  const items = await loadAlertsFeed(sdk, {}, 'rashit', 'me', () => 1000);
  assert.deepEqual(items.map(i => i.id).sort(), ['c-closed', 'c-open']);
  const calloutFetch = calls.find(c => c.op === 'getDocs' && c.path === 'callouts');
  assert.ok(calloutFetch, 'callouts were fetched');
});

await check('loadAlertsFeed activeBoardOverride never re-queries the board bulletin.js already holds live', async () => {
  const { sdk, calls } = fakeSdk({
    boards: [{ id: 'rashit', name: 'ראשית' }, { id: 'crew_b', name: 'משמרת ב' }],
    boardMessages: { crew_b: [{ id: 'm2', data: { text: 'הודעה', by_uid: 'other', created_key: 5 } }] },
    calloutDocs: []
  });
  const liveMessages = [{ id: 'm1', data: () => ({ text: 'חי', by_uid: 'other', created_key: 9 }) }];
  const items = await loadAlertsFeed(sdk, {}, 'rashit', 'me', () => 1000, { id: 'rashit', messages: liveMessages });
  const rashitQuery = calls.find(c => c.op === 'getDocs' && c.path === 'rashit/bulletin_messages');
  assert.equal(rashitQuery, undefined, 'must never issue a getDocs on the overridden board\'s own path');
  assert.ok(items.some(i => i.id === 'rashit/m1'), 'the overridden board\'s live message still appears in the feed');
  assert.ok(items.some(i => i.id === 'crew_b/m2'), 'the other board is still fetched normally');
});

console.log(passed + ' alerts-feed pure-logic checks passed.');
