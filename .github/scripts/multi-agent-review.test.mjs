import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runReview, selectDiff, parseFindings, safeText } from './multi-agent-review.mjs';
const sha = 'a'.repeat(40), base = 'b'.repeat(40);
const file = { filename: 'functions/example.js', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1 };
const event = { action: 'labeled', sender: { login: 'maintainer' }, label: { name: 'resq-ai:' + sha }, pull_request: { number: 3, head: { sha }, base: { sha: base, ref: 'main', repo: { full_name: 'owner/resq' } } } };
const env = { GITHUB_REPOSITORY: 'owner/resq', GITHUB_TOKEN: 'fake', ANTHROPIC_API_KEY: 'fake', XAI_API_KEY: 'fake', GEMINI_API_KEY: 'fake', ANTHROPIC_REVIEW_MODEL: 'configured', XAI_REVIEW_MODEL: 'configured', GEMINI_REVIEW_MODEL: 'configured' };
env.REVIEW_TRUSTED_ACTORS = 'maintainer';
function harness({ stale = false, failGemini = false, files = [file], reviews = [] } = {}) {
  const calls = []; let fresh = 0;
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    let value;
    if (url.endsWith('/pulls/3')) value = { ...event.pull_request, labels: [event.label], state: 'open', changed_files: files.length, head: { sha: stale && ++fresh >= 3 ? 'c'.repeat(40) : sha } };
    else if (url.includes('/files?')) value = files;
    else if (url.includes('/reviews?')) value = reviews;
    else if (url.endsWith('/reviews')) value = { id: 1 };
    else if (url.includes('api.x.ai')) value = { choices: [{ message: { content: '{"findings":[]}' } }] };
    else if (url.includes('anthropic')) value = { content: [{ type: 'text', text: '{"findings":[]}' }] };
    else if (url.includes('generativelanguage')) {
      if (failGemini) return new Response('private error never log', { status: 429 });
      value = { candidates: [{ content: { parts: [{ text: 'בדיקה מוגבלת בלבד' }] } }] };
    } else throw new Error('Unexpected destination');
    return new Response(JSON.stringify(value));
  };
  // Synthetic admission only; never used by the executable CLI.
  const reservations = [];
  const sharedBudget = { async reserveRequest(request) {
    reservations.push(request);
    return {dispatch:true,id:request.id,requestDigest:request.requestDigest};
  }};
  return { calls, fetcher, sharedBudget, reservations };
}
test('bounded source selection excludes fixtures; detects truncated diff, credentials and budgets', () => {
  assert.equal(selectDiff([file], 1).selected.length, 1);
  assert.equal(selectDiff([file, { ...file, filename: 'fixtures/private.js' }], 2).excluded.length, 1);
  assert.equal(selectDiff([file, { ...file, filename: 'tests/invitation.fixture.mjs' }], 2).excluded.length, 1);
  for (const f of [{ ...file, additions: 2 }, { ...file, patch: undefined }, { ...file, patch: '-old\n+api_key="secretvalue123"' }, { ...file, patch: '-old\n+' + 'a'.repeat(60001) }]) assert.throws(() => selectDiff([f], 1));
  assert.throws(() => selectDiff(Array(41).fill(file), 41));
  assert.throws(() => selectDiff([file], 2));
});
test('model output cannot introduce paths, commands, links or mentions into executable behavior', () => {
  assert.throws(() => parseFindings('{"findings":[{"file":"secret","severity":"high","message":"x"}]}', [{ file: file.filename }]));
  assert.equal(safeText('@person <img> https://evil.test/x').includes('@'), false);
  assert.throws(() => parseFindings('not json', []));
});
test('success: reservation first, three provider calls, SHA-bound comment and no approval', async () => {
  assert(event.label.name.length <= 50);
  const h = harness(); const result = await runReview({ event, env, ...h });
  assert.equal(result.status, 'REVIEW_POSTED');
  const posts = h.calls.filter(c => c.url.endsWith('/reviews'));
  assert.equal(posts.length, 2);
  assert(h.calls.indexOf(posts[0]) < h.calls.findIndex(c => c.url.includes('api.x.ai')));
  for (const p of posts) { const body = JSON.parse(p.options.body); assert.equal(body.commit_id, sha); assert.equal(body.event, 'COMMENT'); }
  assert.equal(h.calls.filter(c => !c.url.includes('api.github.com')).length, 3);
});
test('missing configuration never makes network calls', async () => {
  const h = harness(); await assert.rejects(runReview({ event, env: { ...env, XAI_API_KEY: '' }, ...h }), /NOT_CONFIGURED/); assert.equal(h.calls.length, 0);
});
test('reservation after interrupted or partial run cannot become green on rerun', async () => {
  const h = harness({ reviews: [{ user: { login: 'github-actions[bot]' }, body: `<!-- resq-agent-review-v1:${base}:${sha} -->` }] });
  await assert.rejects(runReview({ event, env, ...h }), /INCOMPLETE_RESERVED/);
  assert.equal(h.calls.filter(c => !c.url.includes('api.github.com')).length, 0);
});
test('arbitrary fork or stale-label event cannot start paid reviews', async () => {
  for (const override of [{ sender: { login: 'outsider' } }, { action: 'opened' }, { label: { name: 'resq-ai-review:old' } }]) {
    const h = harness(); await assert.rejects(runReview({ event: { ...event, ...override }, env, ...h }), /REVIEW_NOT_AUTHORIZED/);
    assert.equal(h.calls.length, 0);
  }
});
test('five reservations cap PR spend', async () => {
  const h = harness({ reviews: Array.from({ length: 5 }, (_, i) => ({ user: { login: 'github-actions[bot]' }, body: '<!-- resq-agent-review-v1:other' + i })) });
  await assert.rejects(runReview({ event, env, ...h }), /REVIEW_BUDGET/);
});
test('stale head prevents final review', async () => {
  const h = harness({ stale: true }); await assert.rejects(runReview({ event, env, ...h }), /STALE_REVIEW/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/reviews')).length, 1);
});
test('Gemini failure retains original findings, fails gate, no retries', async () => {
  const h = harness({ failGemini: true }); await assert.rejects(runReview({ event, env, ...h }), /PARTIAL_REVIEW/);
  assert.equal(h.calls.filter(c => c.url.includes('generativelanguage')).length, 1);
  assert(JSON.parse(h.calls.at(-1).options.body).body.includes('grok: 0'));
});
test('excluded files cannot be reported as complete', async () => {
  const h = harness({ files: [file, { ...file, filename: 'fixtures/private.js' }] });
  await assert.rejects(runReview({ event, env, ...h }), /PARTIAL_REVIEW/);
});
test('workflow keeps PR code away from privileged job', () => {
  const yaml = readFileSync(new URL('../workflows/multi-agent-review.yml', import.meta.url), 'utf8');
  const privileged = yaml.split('\n  review:\n')[1];
  assert(privileged.includes('github.event.pull_request.base.sha'));
  assert(!privileged.includes('head.sha'));
  assert(!privileged.includes('npm '));
  assert(privileged.includes('persist-credentials: false'));
  assert(yaml.includes('permissions: {}'));
  assert(!yaml.includes('contents: write'));
});

test('missing shared budget makes zero network calls despite configured provider secrets', async () => {
  const h=harness(); await assert.rejects(runReview({event,env,...h,sharedBudget:undefined}),/SHARED_BUDGET_REQUIRED/);
  assert.equal(h.calls.length,0);
});

test('all three providers reserve full bounded request before paid fetch', async () => {
  const h=harness();
  const fetcher=async(url,options)=>{
    if(!url.includes('api.github.com')) assert.equal(h.reservations.at(-1)?.requestBody,options.body);
    return h.fetcher(url,options);
  };
  await runReview({event,env,...h,fetcher});
  assert.deepEqual(h.reservations.map(r=>r.provider),['Grok','Claude','Gemini']);
  assert.deepEqual(h.reservations.map(r=>r.maxOutputTokens),[2200,2200,700]);
});

test('denied, replayed or mismatched permits never execute paid calls', async () => {
  for(const mode of ['denied','replayed','mismatched']){
    const h=harness();
    const sharedBudget={async reserveRequest(r){
      if(mode==='denied')throw Error('MONTHLY_CAP_REACHED');
      return {dispatch:mode==='mismatched',id:r.id,requestDigest:'wrong'};
    }};
    await assert.rejects(runReview({event,env,...h,sharedBudget}),/PARTIAL_REVIEW/);
    assert.equal(h.calls.filter(c=>!c.url.includes('api.github.com')).length,0);
  }
});
