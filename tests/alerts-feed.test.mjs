// 42H.20 §5.4 · pure-logic unit tests for alerts-feed.js (no browser, no
// Firestore emulator needed — only the merge/filter/count helpers, which
// hold all of the feed's actual filtering logic).
import assert from 'node:assert/strict';
import { bulletinFeedItem, calloutFeedItem, mergeFeedItems, applyFeedFilter, unreadFeedCount, ALERT_FEED_FILTERS }
  from '../alerts-feed.js';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }

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

console.log(passed + ' alerts-feed pure-logic checks passed.');
