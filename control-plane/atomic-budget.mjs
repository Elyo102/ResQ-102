// Isolated Firestore REST adapter. No credentials, HTTP or provider calls here.
// serverNow MUST come from a fresh authenticated server readTime, not Date.now.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const BUDGET_PROJECT = 'resq-agent-control-20260928';
export const BUDGET_ROOT = `projects/${BUDGET_PROJECT}/databases/(default)/documents/`;
export const POLICY_PATH = 'resq_budget_state/policy';
export const CAP_MICRO_USD = 20_000_000;
const CHARGE = 250_000, MAX_BYTES = 60_000, MAX_OUTPUT = 2200;
const TTL_MS = 20_000, BLACKOUT_MS = 120_000;
const providers = ['Claude', 'Grok', 'Gemini'];
export const TASK_BINDINGS=Object.freeze({Claude:'planner_draft_recovery',Grok:'swap_race_review',Gemini:'clean_checkout_gates'});
export const PRINCIPAL='resq-ci-budget-20260928';
const authorizationPattern=/^[A-Za-z0-9-]{8,64}$/;
export function operationId(authorizationId,provider){if(!authorizationPattern.test(authorizationId||'')||!providers.includes(provider))throw Error('BUDGET_INVALID_REQUEST');return `${authorizationId}_${provider}`;}
const hash = /^[a-f0-9]{64}$/;
const plain = v => v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fail = code => { throw new Error(code); };
function keys(value, expected) {
  if (!plain(value) || Reflect.ownKeys(value).length !== expected.length
      || expected.some(k => !Object.hasOwn(value, k))) fail('BUDGET_INVALID_DATA');
}
function value(field, type) { keys(field, [type]); return field[type]; }
function integer(field) {
  const raw = value(field, 'integerValue');
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) fail('BUDGET_INVALID_DATA');
  const n = Number(raw); if (!Number.isSafeInteger(n)) fail('BUDGET_INVALID_DATA'); return n;
}
function string(field) { const s = value(field, 'stringValue'); if (typeof s !== 'string') fail('BUDGET_INVALID_DATA'); return s; }
function timestamp(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(raw)) fail('BUDGET_INVALID_DATA');
  const n = Date.parse(raw); if (!Number.isSafeInteger(n) || n < 0) fail('BUDGET_INVALID_DATA'); return n;
}
function instant(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 253402300799999) fail('BUDGET_INVALID_CLOCK');
  return n;
}
function monthAt(at) {
  const d = new Date(instant(at)), year = d.getUTCFullYear(), month = d.getUTCMonth() + 1;
  const next = new Date(at); next.setUTCDate(1); next.setUTCHours(0, 0, 0, 0); next.setUTCMonth(next.getUTCMonth() + 1);
  if (next.getTime() - at <= BLACKOUT_MS) fail('BUDGET_MONTH_BLACKOUT');
  return { year, month, monthId: `month_${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}` };
}
function document(doc, path) {
  if (!plain(doc) || doc.name !== BUDGET_ROOT + path || !plain(doc.fields)) fail('BUDGET_INVALID_DATA');
  timestamp(doc.updateTime); return doc.fields;
}
function policy(doc) {
  const f = document(doc, POLICY_PATH);
  keys(f, ['enabled', 'version', 'chargeMicroUsd', 'maxBytes', 'maxOutputTokens', 'models', 'pricing']);
  const enabled = value(f.enabled, 'booleanValue');
  if (typeof enabled !== 'boolean') fail('BUDGET_INVALID_DATA');
  if (!enabled) fail('BUDGET_DISABLED');
  const version = string(f.version);
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(version) || integer(f.chargeMicroUsd) !== CHARGE
      || integer(f.maxBytes) !== MAX_BYTES || integer(f.maxOutputTokens) !== MAX_OUTPUT) fail('BUDGET_INVALID_POLICY');
  const map = value(f.models, 'mapValue'); keys(map, ['fields']); keys(map.fields, providers);
  const models = Object.fromEntries(providers.map(p => {
    const model = string(map.fields[p]); if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(model)) fail('BUDGET_INVALID_POLICY');
    return [p, model];
  }));
  const prices=value(f.pricing,'mapValue');keys(prices,['fields']);keys(prices.fields,providers);
  const pricing=Object.fromEntries(providers.map(provider=>{
    const entry=value(prices.fields[provider],'mapValue');keys(entry,['fields']);
    const q=entry.fields;keys(q,['inputMicroUsdPerMillionTokens','outputMicroUsdPerMillionTokens','overheadTokens','fixedMicroUsd','expiresAt']);
    const input=integer(q.inputMicroUsdPerMillionTokens),output=integer(q.outputMicroUsdPerMillionTokens),overhead=integer(q.overheadTokens),fixed=integer(q.fixedMicroUsd);
    if(input>1e9||output>1e9||overhead!==1024||fixed>CHARGE)fail('BUDGET_INVALID_PRICING');
    return [provider,{input,output,overhead,fixed,expiresAt:timestamp(value(q.expiresAt,'timestampValue'))}];
  }));
  return { version, models, pricing };
}
function pinRequest(input) {
  keys(input, ['id', 'provider', 'model', 'requestDigest', 'requestBody', 'maxOutputTokens','task']);
  const d = Object.getOwnPropertyDescriptors(input);
  if (Object.values(d).some(x => !Object.hasOwn(x, 'value'))) fail('BUDGET_INVALID_REQUEST');
  const r = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.value]));
  if (typeof r.id !== 'string' || typeof r.requestDigest !== 'string' || !hash.test(r.requestDigest) || !providers.includes(r.provider)||r.task!==TASK_BINDINGS[r.provider]
      || typeof r.model !== 'string' || typeof r.requestBody !== 'string'
      || !Number.isSafeInteger(r.maxOutputTokens) || r.maxOutputTokens < 1 || r.maxOutputTokens > MAX_OUTPUT) fail('BUDGET_INVALID_REQUEST');
  const inputBytes = Buffer.byteLength(r.requestBody, 'utf8');
  if (inputBytes < 1 || inputBytes > MAX_BYTES
      || createHash('sha256').update(r.requestBody).digest('hex') !== r.requestDigest) fail('BUDGET_INVALID_REQUEST');
  return Object.freeze({ ...r, inputBytes });
}
const s = stringValue => ({ stringValue });
const i = n => ({ integerValue: String(n) });
const ts=n=>({timestampValue:new Date(n).toISOString()});
const map=fields=>({mapValue:{fields}});
function unpackMap(field){const v=value(field,'mapValue');if(plain(v)&&Reflect.ownKeys(v).length===0)return {};keys(v,['fields']);if(!plain(v.fields))fail('BUDGET_INVALID_DATA');return v.fields;}
function grant(doc,path,{authorizationId,approvedSha,principal}){
 const f=document(doc,path);keys(f,['authorizationId','principal','approvedSha','enabled','expiresAt','monthId','allowedTasks','capMicroUsd','maxReservations','chargedMicroUsd','reservationCount','reservedProviders','lastOperationId','operations']);
 if(string(f.authorizationId)!==authorizationId||string(f.principal)!==principal||string(f.approvedSha)!==approvedSha||value(f.enabled,'booleanValue')!==true||integer(f.capMicroUsd)!==750000||integer(f.maxReservations)!==3)fail('BUDGET_GRANT_DENIED');
 const tasks=unpackMap(f.allowedTasks);keys(tasks,providers);for(const p of providers)if(string(tasks[p])!==TASK_BINDINGS[p])fail('BUDGET_GRANT_DENIED');
 const ops=unpackMap(f.operations),count=integer(f.reservationCount),charged=integer(f.chargedMicroUsd),a=value(f.reservedProviders,'arrayValue');
 const empty=plain(a)&&Reflect.ownKeys(a).length===0;if(!empty)keys(a,['values']);
 if(!empty&&!Array.isArray(a.values))fail('BUDGET_INVALID_DATA');const reserved=(empty?[]:a.values).map(string);
 if(count>3||charged!==count*CHARGE||reserved.length!==count||new Set(reserved).size!==count||Object.keys(ops).length!==count||reserved.some(p=>!providers.includes(p)||!Object.hasOwn(ops,p)))fail('BUDGET_INVALID_GRANT');
 for(const p of reserved){
  const op=unpackMap(ops[p]);keys(op,['id','provider','model','policyVersion','requestDigest','task','chargedMicroUsd','inputBytes','maxOutputTokens','createdAt','expiresAt']);
  if(string(op.id)!==`${authorizationId}_${p}`||string(op.provider)!==p||string(op.task)!==TASK_BINDINGS[p]||integer(op.chargedMicroUsd)!==CHARGE||!hash.test(string(op.requestDigest))||integer(op.inputBytes)<1||integer(op.inputBytes)>MAX_BYTES||integer(op.maxOutputTokens)<1||integer(op.maxOutputTokens)>MAX_OUTPUT||!string(op.model)||!string(op.policyVersion))fail('BUDGET_INVALID_GRANT');
  const created=timestamp(value(op.createdAt,'timestampValue')),end=timestamp(value(op.expiresAt,'timestampValue'));
  if(end<=created||end-created>TTL_MS)fail('BUDGET_INVALID_GRANT');
 }
 if(string(f.lastOperationId)!==(count?`${authorizationId}_${reserved.at(-1)}`:''))fail('BUDGET_INVALID_GRANT');
 return {fields:f,ops,reserved,count,charged,monthId:string(f.monthId),expiresAt:timestamp(value(f.expiresAt,'timestampValue'))};
}

export function createAtomicBudget({ transport, authorizationId,approvedSha,principal=PRINCIPAL,monotonic = () => performance.now() } = {}) {
  if(!authorizationPattern.test(authorizationId||'')||!/^[a-f0-9]{40}$/.test(approvedSha||'')||principal!==PRINCIPAL)fail('BUDGET_AUTHORIZATION_REQUIRED');
  if (!transport || ['get', 'commit', 'serverNow'].some(k => typeof transport[k] !== 'function')
      || typeof monotonic !== 'function') fail('BUDGET_TRANSPORT_REQUIRED');
  const permits = new WeakMap();
  const mono = () => { const n = monotonic(); if (!Number.isFinite(n) || n < 0) fail('BUDGET_INVALID_CLOCK'); return n; };
  async function get(path) {
    try { const result = await transport.get(path); if (result === undefined) fail('BUDGET_INVALID_DATA'); return result; } catch (e) { if (e?.status === 404) return null; fail('BUDGET_READ_FAILED'); }
  }
  function estimated(sample) {
    const elapsed = mono() - sample.started;
    if (elapsed < 0) fail('BUDGET_INVALID_CLOCK');
    // Count the complete sampling round trip conservatively toward expiry.
    return sample.server + Math.ceil(elapsed);
  }
  function live(sample, expiresAt, monthId) {
    const at = estimated(sample);
    if (at >= expiresAt) fail('BUDGET_PERMIT_EXPIRED');
    if (monthAt(at).monthId !== monthId) fail('BUDGET_PERMIT_EXPIRED');
  }
  return Object.freeze({
    async reserveRequest(input) {
      const r = pinRequest(input);
      if(r.id!==`${authorizationId}_${r.provider}`)fail('BUDGET_INVALID_REQUEST');
      const grantPath=`resq_budget_authorizations/${authorizationId}`;
      const [pDoc,gDoc]=await Promise.all([get(POLICY_PATH),get(grantPath)]);
      if (!pDoc) fail('BUDGET_POLICY_MISSING');
      const p = policy(pDoc);
      if (p.models[r.provider] !== r.model) fail('BUDGET_MODEL_DENIED');
      if(!gDoc)fail('BUDGET_GRANT_MISSING');
      const g=grant(gDoc,grantPath,{authorizationId,approvedSha,principal});
      if(Object.hasOwn(g.ops,r.provider)){
        const f=unpackMap(g.ops[r.provider]);
        if (string(f.provider) !== r.provider || string(f.model) !== r.model || string(f.policyVersion) !== p.version
            || string(f.requestDigest) !== r.requestDigest || integer(f.inputBytes) !== r.inputBytes
            || integer(f.maxOutputTokens) !== r.maxOutputTokens) fail('BUDGET_RESERVATION_CONFLICT');
        return Object.freeze({ dispatch: false, id: r.id, requestDigest: r.requestDigest, reason: 'ALREADY_RESERVED' });
      }
      const started = mono();
      let server; try { server = instant(await transport.serverNow()); } catch { fail('BUDGET_SERVER_TIME_UNAVAILABLE'); }
      const sample = { started, server };
      const scope = monthAt(estimated(sample));
      const price=p.pricing[r.provider];
      if(price.expiresAt<=estimated(sample)||price.fixed+Math.ceil(((r.inputBytes+price.overhead)*price.input+r.maxOutputTokens*price.output)/1e6)>CHARGE)fail('BUDGET_PRICE_DENIED');
      if(g.monthId!==scope.monthId||g.expiresAt<=estimated(sample))fail('BUDGET_GRANT_EXPIRED');
      if(g.count>=3||g.charged>750000-CHARGE)fail('BUDGET_GRANT_CAP');
      const expiresAt = Math.min(server + TTL_MS,g.expiresAt,price.expiresAt);
      const monthPath = `resq_budget_state/${scope.monthId}`;
      const monthDoc = await get(monthPath);
      if (!monthDoc) fail('BUDGET_MONTH_MISSING');
      const f = document(monthDoc, monthPath);
      keys(f, ['year', 'month', 'chargedMicroUsd', 'lastOperationId','lastAuthorizationId']);
      const charged = integer(f.chargedMicroUsd), last = string(f.lastOperationId);
      if (integer(f.year) !== scope.year || integer(f.month) !== scope.month
          || charged > CAP_MICRO_USD || charged % CHARGE !== 0
          || (charged === 0 ? last !== ''||string(f.lastAuthorizationId)!=='' : !authorizationPattern.test(string(f.lastAuthorizationId))||!providers.some(p=>last===`${string(f.lastAuthorizationId)}_${p}`))) fail('BUDGET_INVALID_DATA');
      if (charged > CAP_MICRO_USD - CHARGE) fail('BUDGET_CAP_REACHED');
      live(sample, expiresAt, scope.monthId);
      const fields = { id:s(r.id),provider: s(r.provider), model: s(r.model), policyVersion: s(p.version), requestDigest: s(r.requestDigest),task:s(r.task),
        chargedMicroUsd: i(CHARGE), expiresAt:ts(expiresAt), inputBytes: i(r.inputBytes), maxOutputTokens: i(r.maxOutputTokens) };
      const writes = [
        { update: { name: BUDGET_ROOT + monthPath, fields: { chargedMicroUsd: i(charged + CHARGE), lastOperationId: s(r.id),lastAuthorizationId:s(authorizationId) } },
          updateMask: { fieldPaths: ['chargedMicroUsd', 'lastOperationId','lastAuthorizationId'] }, currentDocument: { updateTime: monthDoc.updateTime } },
        { update: { name: BUDGET_ROOT + grantPath, fields:{chargedMicroUsd:i(g.charged+CHARGE),reservationCount:i(g.count+1),reservedProviders:{arrayValue:{values:[...g.reserved,r.provider].map(s)}},lastOperationId:s(r.id),operations:map({[r.provider]:map(fields)})} },
          updateMask:{fieldPaths:['chargedMicroUsd','reservationCount','reservedProviders','lastOperationId',`operations.${r.provider}`]},currentDocument:{updateTime:gDoc.updateTime},
          updateTransforms: [{ fieldPath: `operations.${r.provider}.createdAt`, setToServerValue: 'REQUEST_TIME' }] }
      ];
      let committed;
      try { committed = await transport.commit(writes); } catch { fail('BUDGET_COMMIT_UNKNOWN'); }
      if (!plain(committed) || !Array.isArray(committed.writeResults) || committed.writeResults.length !== 2) fail('BUDGET_COMMIT_UNKNOWN');
      let commitAt; try { commitAt = timestamp(committed.commitTime); } catch { fail('BUDGET_COMMIT_UNKNOWN'); }
      if (commitAt < server || commitAt >= expiresAt || monthAt(commitAt).monthId !== scope.monthId) fail('BUDGET_COMMIT_UNKNOWN');
      live(sample, expiresAt, scope.monthId);
      const permit = Object.freeze({ dispatch: true, id: r.id, requestDigest: r.requestDigest, expiresAtMs: expiresAt });
      permits.set(permit, { sample, expiresAt, monthId: scope.monthId });
      return permit;
    },
    assertDispatch(permit) {
      const info = permits.get(permit);
      if (!info) fail('BUDGET_PERMIT_INVALID');
      permits.delete(permit); // A failed/expired check can never be tried again.
      live(info.sample, info.expiresAt, info.monthId);
      return true;
    }
  });
}
