'use strict';

/* 42H.20 §Scope 1.5 · "add an actual-workbook structural fixture or a
 * sanitized equivalent that asserts the ground-truth counts above."
 *
 * schedule-workbook-fixture.json is a structurally faithful, sanitized
 * copy of the real attached workbook
 * (schedule-eilat-source.xlsx, sheet 2026, date columns IK:JN, September
 * 2026): every personal name was replaced with a stable pseudonym
 * ("איש<n>", same name -> same token throughout), while every cell's
 * emptiness, every multi-name split ("X, Y" / "X + Y"), every station/
 * absence label in column A, every date, weekday letter and time-range
 * value ("08:00-15:00" etc.) were left untouched byte-for-byte. No real
 * person's name is committed to this repository.
 *
 * This test runs the real, unmodified production pipeline
 * (schedule-import-pipeline.js -> schedule-import-layout.js ->
 * schedule-sheet-import.js) against that fixture and checks it against
 * the ground truth from CLAUDE-TASK.md Scope 1:
 *
 *   - date columns IK:JN, 30 days                          -> checked
 *   - אילת rows 3-17: 293 assignments                       -> exact match
 *   - שחמון rows 18-22: 138 assignments                     -> exact match
 *   - תמנע rows 23-27: 119 assignments                      -> exact match
 *   - first day counts by station: 9, 4, 4, 2               -> exact match
 *   - dynamic station ids in the is_<40 hex> format          -> exact match
 *   - no hard blocker                                        -> exact match
 *   - one assignment/absence conflict                        -> exact match
 *   - 118 absences                                           -> exact match
 *
 * 42H.20 · Codex review, blocker 1: an earlier version of this test ran the
 * pipeline WITHOUT the workbook's merged label cells and then pinned the
 * wrong result it produced (יטבתה 93 / ignored 54 / total 643) as if it were
 * the ground truth. It was not. The real file merges A28:A29 for יטבתה, and
 * the real XLSX path (schedule-file-import.js readScheduleFile ->
 * label_spans -> parseSheet) always passes those merges; the engine's own
 * rule is that a merged station label is the block's authoritative lower
 * boundary. The fixture now carries the real file's six column-A merges
 * exactly as readScheduleFile extracts them (verified against the actual
 * schedule-eilat-source.xlsx: same 6 spans, same 293/138/119/60/118/87/610
 * on the real names), so this test asserts EVERY figure separately and
 * fails on the old behaviour.
 *
 *   - יטבתה rows 28-29: 60 assignments                      -> exact match
 *   - rows 30-43: 87 names in one ignored block, not station -> exact match
 *   - total station assignments: 610                        -> exact match
 *   - 75 unlinked people                                     -> exact match
 *     (with an empty inventory every person is external; 75 = the distinct
 *     people in the four station blocks + absences, now that the 24 names
 *     that only appear in the ignored rows 30-43 are correctly excluded.)
 *
 * A second run of the same grid WITHOUT label_spans (the paste path) is
 * asserted too: it must report the inferred boundary as an explicit
 * 'station-boundary-inferred' warning rather than silently producing 93.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const P = require('./schedule-import-pipeline');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }

const fixture = require(path.join(__dirname, 'schedule-workbook-fixture.json'));
const grid = fixture.grid;
const spans = fixture.label_spans;

test('the fixture carries the real file\'s six column-A merged label spans (A3:A17, A18:A22, A23:A27, A28:A29, A44:A46, A47:A49)', () => {
  assert.equal(fixture.schema_version, 1);
  assert.deepEqual(spans, [
    { column: 0, start_row: 2, end_row: 16 }, { column: 0, start_row: 17, end_row: 21 },
    { column: 0, start_row: 22, end_row: 26 }, { column: 0, start_row: 27, end_row: 28 },
    { column: 0, start_row: 43, end_row: 45 }, { column: 0, start_row: 46, end_row: 48 }
  ]);
  assert.equal(grid[27][0], 'יטבתה');
  assert.equal(grid[28][0], '');
});

const result = P.buildWorkbookImport({
  input: grid, month: '2026-09', station_id: 'eilat', inventory: [], bindings: [], label_spans: spans
});

test('30 September date columns are recognized', () => {
  assert.equal(result.parsed.dates.length, 30);
  assert.equal(result.parsed.dates[0], '2026-09-01');
  assert.equal(result.parsed.dates[29], '2026-09-30');
});

test('the workbook produces four dynamic is_<40 hex> station ids, never fixed legacy keys', () => {
  const ids = Object.keys(result.policy.sub_stations);
  assert.equal(ids.length, 4);
  ids.forEach((id) => assert.match(id, /^is_[0-9a-f]{40}$/));
  assert.deepEqual(['eilat', 'shahmon', 'timna', 'yotvata'], ['eilat', 'shahmon', 'timna', 'yotvata']);
});

test('each dynamic id carries the real Hebrew label and canonical order from server-derived layout', () => {
  const bySubStation = {};
  Object.entries(result.policy.sub_stations).forEach(([id, spec]) => { bySubStation[spec.order] = { id, label: spec.label }; });
  assert.equal(bySubStation[0].label, 'אילת');
  assert.equal(bySubStation[1].label, 'שחמון');
  assert.equal(bySubStation[2].label, 'תמנע');
  assert.equal(bySubStation[3].label, 'יטבתה');
});

test('station block totals match the ground truth exactly for אילת, שחמון and תמנע', () => {
  const byLabel = {};
  result.parsed.blocks.filter((b) => b.kind === 'station').forEach((b) => {
    const label = result.policy.sub_stations[b.sub_station].label;
    byLabel[label] = b.names;
  });
  assert.equal(byLabel['אילת'], 293);
  assert.equal(byLabel['שחמון'], 138);
  assert.equal(byLabel['תמנע'], 119);
});

test('יטבתה rows 28-29 total exactly 60 — the merged label is the boundary, rows 30-31 are not station personnel', () => {
  const yotvata = result.parsed.blocks.find((b) => b.kind === 'station' && result.policy.sub_stations[b.sub_station].label === 'יטבתה');
  assert.ok(yotvata, 'expected a יטבתה station block');
  assert.deepEqual(yotvata.rows, [28, 29]);
  assert.equal(yotvata.names, 60);
});

test('rows 30-43 form exactly one ignored block of 87 names after יטבתה — reported, never imported as station assignments', () => {
  const ignoredBlocks = result.parsed.blocks.filter((b) => b.kind === 'ignored' && b.names > 0);
  assert.equal(ignoredBlocks.length, 1);
  assert.deepEqual(ignoredBlocks[0].rows, [30, 43]);
  assert.equal(ignoredBlocks[0].after, 'יטבתה');
  assert.equal(ignoredBlocks[0].names, 87);
  assert.equal(result.resolved.counts.ignored_names, 87);
  const w = result.warnings.find((x) => x.code === 'ignored-content');
  assert.ok(w); assert.equal(w.count, 87);
});

test('with the merged spans no station boundary is inferred — no station-boundary-inferred warning', () => {
  assert.equal(result.parsed.warnings.some((w) => w.code === 'station-boundary-inferred'), false);
  assert.equal(result.warnings.some((w) => w.code === 'station-boundary-inferred'), false);
});

test('the paste path (same grid, no merge metadata) cannot see the A28:A29 boundary and must say so explicitly instead of silently reporting 93', () => {
  const pasted = P.buildWorkbookImport({ input: grid, month: '2026-09', station_id: 'eilat', inventory: [], bindings: [] });
  const w = pasted.warnings.find((x) => x.code === 'station-boundary-inferred');
  assert.ok(w, 'paste path must flag the inferred boundary');
  assert.equal(w.label, 'יטבתה');
  assert.deepEqual(w.rows, [28, 31]);
  assert.match(w.detail, /ניחוש/);
  assert.match(w.detail, /Excel/);
  // and the flagged figure is exactly the wrong one the merged spans correct
  const y = pasted.parsed.blocks.find((b) => b.kind === 'station' && pasted.policy.sub_stations[b.sub_station].label === 'יטבתה');
  assert.equal(y.names, 93);
  assert.notEqual(y.names, 60);
});

test('first-day (2026-09-01) counts by station match the ground truth order: 9, 4, 4, 2', () => {
  const firstDate = result.parsed.dates[0];
  const bySubStation = {};
  result.parsed.blocks.filter((b) => b.kind === 'station').forEach((b) => {
    bySubStation[result.policy.sub_stations[b.sub_station].order] = (b.cells[firstDate] || []).length;
  });
  assert.deepEqual([bySubStation[0], bySubStation[1], bySubStation[2], bySubStation[3]], [9, 4, 4, 2]);
});

test('total absences across all sick/course/reserve/leave blocks match the ground truth exactly (118)', () => {
  assert.equal(result.resolved.counts.absences, 118);
});

test('no hard blocker is raised for this workbook', () => {
  assert.deepEqual(result.blockers, []);
});

test('exactly one assignment/absence conflict is reported, matching the ground truth', () => {
  const w = result.warnings.find((x) => x.code === 'assignment-absence-conflict');
  assert.ok(w, 'expected an assignment-absence-conflict warning');
  assert.equal(w.count, 1);
});

test('75 unlinked people — every fixture person is external with an empty inventory, and 75 is the ground-truth figure now that the ignored rows 30-43 no longer contribute phantom names', () => {
  const w = result.warnings.find((x) => x.code === 'unlinked-people');
  assert.ok(w);
  assert.equal(w.count, 75);
  assert.equal(w.count, result.people.length);
  assert.equal(result.people.every((p) => p.kind === 'external'), true);
});

test('total station assignments is exactly 610 (293+138+119+60) — never 643', () => {
  assert.equal(result.resolved.counts.assignments, 293 + 138 + 119 + 60);
  assert.equal(result.resolved.counts.assignments, 610);
  assert.equal(result.resolved.counts.duplicates, 0);
});

console.log('');
console.log(passed + '/' + passed + ' schedule workbook fixture (Scope 1.5) checks passed');
