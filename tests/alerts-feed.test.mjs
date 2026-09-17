// 42H.20 §5.4 · pure-logic unit tests for alerts-feed.js (no browser, no
// Firestore emulator needed). Since Codex blocker 3 the feed itself is
// fetched by ONE server call (getAlertsFeed); these tests cover the pure
// helpers, the response validation, the single-call loader, and the
// display tracker that gates the view receipt.
import assert from 'node:assert/strict';
import { bulletinFeedItem, calloutFeedItem, mergeFeedItems, applyFeedFilter, unreadFeedCount, ALERT_FEED_FILTERS,
  normalizeFeedResponse, loadAlertsFeed, createDisplayTracker, FEED_SCHEMA } from '../alerts-feed.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

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

// --- Codex blocker 3: server-backed loader ---

const goodResponse = () => ({
  schema: FEED_SCHEMA, generated_at_ms: 1, unread_count: 41,
  items: [
    { kind: 'bulletin', id: 'rashit/m1', board_id: 'rashit', board_name: 'ראשית', text: 'א', by_name: 'ב', time_ms: 5, viewed: false },
    { kind: 'callout', id: 'c1', text: 'ג', by_name: 'ד', active: false, time_ms: 4, viewed: true }
  ],
  window: { boards: 4, messages_per_board: 10, callouts: 25, feed_limit: 30, candidates: 45 }
});

await check('loadAlertsFeed makes exactly one server call with a closed empty payload and no Firestore reads', async () => {
  const calls = [];
  const callable = async (payload) => { calls.push(payload); return { data: goodResponse() }; };
  const feed = await loadAlertsFeed(callable);
  assert.deepEqual(calls, [{}]);
  assert.equal(feed.unread_count, 41, 'the server-side count (45 candidates, 30 returned) is used as-is, not recomputed from the 2 items');
  assert.deepEqual(feed.items.map(i => [i.kind, i.id, i.viewed, i.active]), [['bulletin', 'rashit/m1', false, undefined], ['callout', 'c1', true, false]]);
});

await check('a server error is an error — never silently "unread"', async () => {
  await assert.rejects(loadAlertsFeed(async () => { throw Object.assign(new Error('boom'), { code: 'functions/permission-denied' }); }),
    (e) => e.code === 'functions/permission-denied');
  await assert.rejects(loadAlertsFeed(), TypeError);
});

await check('normalizeFeedResponse rejects a wrong schema, an oversize list, a bad count and malformed items', () => {
  for (const bad of [
    null, {}, { schema: 'other', items: [], unread_count: 0 },
    { schema: FEED_SCHEMA, items: new Array(31).fill(goodResponse().items[1]), unread_count: 0 },
    { schema: FEED_SCHEMA, items: [], unread_count: -1 },
    { schema: FEED_SCHEMA, items: [], unread_count: '3' },
    { schema: FEED_SCHEMA, items: [{ kind: 'bulletin', id: 'm1', board_id: 'rashit' }], unread_count: 0 },
    { schema: FEED_SCHEMA, items: [{ kind: 'mystery', id: 'x' }], unread_count: 0 },
    { schema: FEED_SCHEMA, items: [{ kind: 'callout', id: '' }], unread_count: 0 }
  ]) assert.throws(() => normalizeFeedResponse(bad), Error, JSON.stringify(bad));
  const ok = normalizeFeedResponse(goodResponse());
  assert.equal(ok.items[0].viewed, false);
  assert.equal(ok.items[1].viewed, true);
});

await check('viewed is only ever the server\'s boolean true — a truthy string does not count', () => {
  const r = goodResponse(); r.items[0].viewed = 'yes';
  assert.equal(normalizeFeedResponse(r).items[0].viewed, false);
});

// --- Codex blocker 3.4 / 8: display tracker ---

function fakeDom() {
  const nodes = [];
  const container = {
    querySelectorAll: (selector) => nodes.filter(n => n.dataset.viewed === 'false' && selector.includes('data-feed-id'))
  };
  const add = (id, kind, viewed) => {
    const node = { dataset: { feedId: id, feedKind: kind, viewed: String(viewed), feedBoard: 'rashit', feedMessage: id.split('/')[1] || '' }, isConnected: true };
    nodes.push(node); return node;
  };
  return { container, add, nodes };
}
class FakeObserver {
  constructor(cb, opts) { this.cb = cb; this.opts = opts; this.observed = []; FakeObserver.last = this; }
  observe(node) { this.observed.push(node); }
  disconnect() { this.disconnected = true; }
  fire(entries) { this.cb(entries); }
}
const tick = (ms) => new Promise(r => setTimeout(r, ms));

await check('not displayed → not marked: rendering alone sends no receipt', async () => {
  const dom = fakeDom(); dom.add('rashit/m1', 'bulletin', false);
  const marks = [];
  const tracker = createDisplayTracker({ document: { visibilityState: 'visible' }, IntersectionObserver: FakeObserver,
    markViewed: async (t) => marks.push(t), dwellMs: 5 });
  tracker.observe(dom.container);
  await tick(20);
  assert.deepEqual(marks, []);
  FakeObserver.last.fire([{ target: dom.nodes[0], isIntersecting: false, intersectionRatio: 0 }]);
  await tick(20);
  assert.deepEqual(marks, [], 'off-screen item is never marked');
});

await check('displayed ≥60% for the dwell → marked exactly once; a refresh does not mark it again', async () => {
  const dom = fakeDom(); const node = dom.add('rashit/m1', 'bulletin', false);
  const marks = [];
  const confirmed = [];
  const tracker = createDisplayTracker({ document: { visibilityState: 'visible' }, IntersectionObserver: FakeObserver,
    markViewed: async (t) => marks.push(t), onConfirmed: (k) => confirmed.push(k), dwellMs: 5 });
  tracker.observe(dom.container);
  FakeObserver.last.fire([{ target: node, isIntersecting: true, intersectionRatio: 0.5 }]);
  await tick(20);
  assert.deepEqual(marks, [], 'below the 60% threshold nothing is sent');
  FakeObserver.last.fire([{ target: node, isIntersecting: true, intersectionRatio: 0.9 }]);
  FakeObserver.last.fire([{ target: node, isIntersecting: true, intersectionRatio: 0.9 }]);
  await tick(20);
  assert.deepEqual(marks, [{ kind: 'bulletin', id: 'rashit/m1', board_id: 'rashit', message_id: 'm1' }]);
  assert.deepEqual(confirmed, ['rashit/m1']);
  assert.equal(node.dataset.viewed, 'true');
  // refresh: the list is re-rendered and re-observed; the confirmed item is not sent again
  const node2 = dom.add('rashit/m1', 'bulletin', false);
  tracker.observe(dom.container);
  FakeObserver.last.fire([{ target: node2, isIntersecting: true, intersectionRatio: 1 }]);
  await tick(20);
  assert.equal(marks.length, 1, 'a refresh never doubles the receipt');
});

await check('leaving the viewport before the dwell elapses cancels the receipt; a hidden tab never marks', async () => {
  const dom = fakeDom(); const node = dom.add('c1', 'callout', false);
  const marks = [];
  const visibility = { visibilityState: 'visible' };
  const tracker = createDisplayTracker({ document: visibility, IntersectionObserver: FakeObserver,
    markViewed: async (t) => marks.push(t), dwellMs: 30 });
  tracker.observe(dom.container);
  FakeObserver.last.fire([{ target: node, isIntersecting: true, intersectionRatio: 1 }]);
  await tick(5);
  FakeObserver.last.fire([{ target: node, isIntersecting: false, intersectionRatio: 0 }]);
  await tick(50);
  assert.deepEqual(marks, [], 'a glimpse shorter than the dwell is not a view');
  FakeObserver.last.fire([{ target: node, isIntersecting: true, intersectionRatio: 1 }]);
  visibility.visibilityState = 'hidden';
  await tick(50);
  assert.deepEqual(marks, [], 'a tab that went hidden during the dwell does not count');
});

await check('a failed receipt write leaves the item unviewed and does not throw into the page', async () => {
  const dom = fakeDom(); const node = dom.add('rashit/m9', 'bulletin', false);
  const tracker = createDisplayTracker({ document: { visibilityState: 'visible' }, IntersectionObserver: FakeObserver,
    markViewed: async () => { throw new Error('offline'); }, dwellMs: 5 });
  tracker.observe(dom.container);
  FakeObserver.last.fire([{ target: node, isIntersecting: true, intersectionRatio: 1 }]);
  await tick(20);
  assert.equal(node.dataset.viewed, 'false');
  assert.equal(tracker.confirmed.size, 0);
});

console.log(passed + ' alerts-feed pure-logic checks passed.');
