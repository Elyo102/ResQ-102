import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pages = [
  ['attendance', fs.readFileSync(path.join(root, 'attendance.html'), 'utf8')],
  ['guards', fs.readFileSync(path.join(root, 'guards.html'), 'utf8')]
];
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (error) {
    console.error('FAIL ' + name);
    throw error;
  }
}

function executableSource(source) {
  return source
    .replace(/<!--[^]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function extractFunction(source, name) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, name + ' helper missing');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(name + ' helper is not balanced');
}

function compatibilityAdapter(source) {
  const date = source.match(/const COMPATIBILITY_DATE_RE\s*=\s*[^;]+;/);
  const fields = source.match(/const COMPATIBILITY_ROTATION_FIELDS\s*=\s*\[[\s\S]*?\];/);
  assert.ok(date && fields, 'compatibility constants missing');
  return Function(date[0] + '\n' + fields[0] + '\n' +
    extractFunction(source, 'legacyCompatibilityData') +
    '\nreturn legacyCompatibilityData;')();
}

for (const [name, raw] of pages) {
  const source = executableSource(raw);

  test(name + ': declares the server compatibility callable', () => {
    assert.match(source,
      /httpsCallable\(fns,\s*['"]getLegacyScheduleCompatibilityContext['"]\)/);
  });

  test(name + ': never reads legacy rotations directly', () => {
    assert.doesNotMatch(source,
      /(?:collection|doc)\s*\([\s\S]{0,180}?['"]rotations['"]/);
  });

  test(name + ': never reads legacy overrides directly', () => {
    assert.doesNotMatch(source,
      /(?:collection|doc)\s*\([\s\S]{0,180}?['"]shift_overrides['"]/);
  });

  test(name + ': invokes compatibility with the smallest explicit range and no station selector', () => {
    if (name === 'attendance') {
      assert.match(source,
        /callLegacyScheduleCompatibilityContext\s*\(\s*guardMonthRange\(snapshot\.year,\s*snapshot\.month\)\s*\)/);
    } else {
      assert.match(source,
        /history:\s*\{\s*from:guardDayOffset\(today,\s*-365\),\s*to:guardDayOffset\(today,\s*-1\)\s*\}/);
      assert.match(source,
        /upcoming:\s*\{\s*from:today,\s*to:guardDayOffset\(today,\s*365\)\s*\}/);
      assert.match(source,
        /guardCall\.compatibility\(ranges\.history\)[\s\S]*?guardCall\.compatibility\(ranges\.upcoming\)/);
      assert.doesNotMatch(source,
        /guardCall\.compatibility\s*\(\s*\{\s*from:\s*ranges\.history\.from,\s*to:\s*ranges\.upcoming\.to/,
        'guards must never request one 731-day compatibility range');
    }
    assert.doesNotMatch(source,
      /(?:callLegacyScheduleCompatibilityContext|guardCall\.compatibility)\s*\([^)]*(?:station|sid|SID)/);
  });

  test(name + ': consumes and constrains mode, rotations and overrides', () => {
    assert.match(source, /data\.mode\s*!==\s*['"]off['"]/);
    assert.match(source, /data\.mode\s*!==\s*['"]shadow['"]/);
    assert.match(source, /Array\.isArray\(data\.rotations\)/);
    assert.match(source, /typeof data\.overrides\s*!==\s*['"]object['"]/);
    assert.match(source, /scheduleCompatibilityMode\s*=/);
  });

  test(name + ': excludes override notes and copies only operational fields', () => {
    const helper = extractFunction(source, 'legacyCompatibilityData');
    assert.doesNotMatch(helper, /\.note|\['note'\]/);
    assert.match(helper, /extra_crews:\s*row\.extra_crews\.slice\(\)/);
  });

  test(name + ': valid off/shadow payloads preserve calculations and malformed/new payloads fail closed', () => {
    const adapt = compatibilityAdapter(source);
    const payload = {
      mode: 'off',
      rotations: [{ crew:'A', position_in_cycle:0, cycle_days:3,
        anchor_date:'2026-09-01', is_active:true, unknown:'drop-me' }],
      overrides: {
        '2026-09-02': { date:'2026-09-02', kind:'standby', crew:'',
          extra_crews:['B'], note:'must-not-cross' }
      }
    };
    const result = adapt({ data:payload });
    assert.equal(result.mode, 'off');
    assert.equal(result.rotations[0].crew, 'A');
    assert.equal(Object.hasOwn(result.rotations[0], 'unknown'), false);
    assert.deepEqual(result.overrides['2026-09-02'].extra_crews, ['B']);
    assert.equal(Object.hasOwn(result.overrides['2026-09-02'], 'note'), false);
    assert.equal(adapt({ data:{ ...payload, mode:'shadow' } }).mode, 'shadow');
    assert.throws(() => adapt({ data:{ ...payload, mode:'new' } }),
      /legacy-schedule-compatibility-shape/);
    assert.throws(() => adapt({ data:{ ...payload, overrides:{ bad:{ date:'bad', extra_crews:[] } } } }),
      /legacy-schedule-override-shape/);
    if (name === 'guards') {
      const merge = Function(extractFunction(source, 'mergeLegacyCompatibility') +
        '\nreturn mergeLegacyCompatibility;')();
      const first = adapt({ data:payload });
      const second = adapt({ data:{ ...payload, overrides:{} } });
      assert.equal(merge([first, second]).mode, 'off');
      assert.throws(() => merge([first, { ...second, mode:'shadow' }]),
        /legacy-schedule-compatibility-mismatch/);
      assert.throws(() => merge([first, { ...second,
        rotations:[{ ...second.rotations[0], crew:'B' }] }]),
        /legacy-schedule-compatibility-mismatch/);
      assert.throws(() => merge([first, first]), /legacy-schedule-override-overlap/);
    }
  });

  test(name + ': exposes a Hebrew failure and clears only schedule-derived state', () => {
    const helper = extractFunction(source, 'showLegacyCompatibilityFailure');
    assert.match(helper, /[\u0590-\u05ff]{2,}/);
    assert.match(helper, /rotations\s*=\s*\[\]/);
    assert.match(helper, /overrides\s*=\s*\{\}/);
    assert.match(helper, /['"]err['"]/);
    if (name === 'guards') {
      assert.match(helper, /scheduleClassificationAvailable\s*=\s*false/);
      assert.doesNotMatch(helper, /(?:guards|memberGuards|managerGuards|people)\s*=\s*\[\]/,
        'schedule failure must not erase the independent guard board or manager data');
    }
  });

  test(name + ': failure path blocks calculations without hiding independent operations', () => {
    if (name === 'attendance') {
      assert.match(source,
        /if \(compatibilityFailure \|\| !next\.compatibility\) \{[\s\S]*?showLegacyCompatibilityFailure\(\);[\s\S]*?return false;/);
      return;
    }
    assert.match(source,
      /if \(compatibility\.error \|\| !compatibility\.data\) \{[\s\S]*?scheduleClassificationAvailable\s*=\s*false;[\s\S]*?memberGuards\s*=\s*boards\.memberGuards;[\s\S]*?syncGuardView\(\);[\s\S]*?showLegacyCompatibilityFailure\(\)/);
    assert.match(source, /loadMap\s*=\s*CAN_MANAGE\s*&&\s*scheduleClassificationAvailable/);
    assert.match(source,
      /loadByPerson\([\s\S]{0,180}?guardHistoryRange\s*&&\s*guardHistoryRange\.from,[\s\S]{0,120}?guardHistoryRange\s*&&\s*guardHistoryRange\.to/,
      'annual ranking must be bounded at both ends and exclude future guards');
    assert.match(source, /scheduleClassificationAvailable[\s\S]*?\?\s*dutyKind/);
  });

  test(name + ': stale concurrent loads cannot publish schedule-derived state', () => {
    if (name === 'attendance') {
      assert.match(source, /const generation = \+\+staticLoadGeneration/);
      assert.match(source, /const next = \{\}/);
      assert.match(source, /generation === staticLoadGeneration/);
      assert.match(source, /year:\s*viewYear/);
      assert.match(source, /month:\s*viewMonth/);
      assert.match(source,
        /viewYear === snapshot\.year && viewMonth === snapshot\.month/);
      assert.match(source,
        /\$\('next'\)\.onclick[\s\S]{0,260}?await loadStatic\(\)[\s\S]{0,80}?await loadMonth\(\)/);
    } else {
      assert.match(source, /const generation = \+\+guardLoadGeneration/);
      assert.match(source, /const next = \{ people:\[\], quals:\[\], held:\{\}, swaps:\[\], busy:\{\} \}/);
      assert.match(source, /generation === guardLoadGeneration/);
      const staleGate = source.indexOf('if (!current) return false;');
      const publish = source.indexOf('scheduleCompatibilityMode = compatibility.data.mode;');
      assert.ok(staleGate !== -1 && publish > staleGate,
        'guard compatibility state must publish only after the stale-load gate');
    }
  });
}

console.log('\n' + passed + '/' + (pages.length * 10) + ' schedule compatibility source checks passed');
