// Read-only REST adapter. No retries, writes, arbitrary endpoints or secret logging.
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function requireThat(ok) { if (!ok) throw Error('BACKUP_REST_INVALID'); }
function segments(value, parity) {
  requireThat(typeof value === 'string');
  const parts = value.split('/');
  requireThat(parts.length<=100 && parts.length % 2 === parity && parts.every(p => p && p !== '.' && p !== '..' && !/[\u0000-\u001f]/.test(p)));
  return parts;
}
function timestamp(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value));
  const date = new Date(value);
  requireThat(Number.isFinite(date.getTime()) && date.toISOString().slice(0,19) === value.slice(0,19));
  const nanos = Number((value.match(/\.(\d+)Z$/)?.[1] || '').padEnd(9,'0'));
  return {...{__ts:date.toISOString()}, ...(nanos % 1000000 ? {__nanos:nanos % 1000000} : {})};
}
export function convertRestFields(fields, prefix) {
  requireThat(object(fields));
  const result = {};
  for (const [key,value] of Object.entries(fields)) {
    // Existing snapshot format cannot distinguish these ordinary map keys from type markers.
    requireThat(!['__proto__','constructor','prototype','__ts','__nanos','__bytes','__ref','__geo'].includes(key));
    result[key] = convertRestValue(value,prefix);
  }
  requireThat(!(typeof result.latitude==='number' && typeof result.longitude==='number' && Object.keys(result).length<=3 && !result.path));
  requireThat(!(typeof result.path==='string' && object(result.firestore)));
  return result;
}
export function convertRestValue(value, prefix) {
  requireThat(object(value) && Object.keys(value).length === 1);
  const [kind] = Object.keys(value), v = value[kind];
  switch (kind) {
    case 'nullValue': requireThat(v === null); return null;
    case 'booleanValue': requireThat(typeof v === 'boolean'); return v;
    case 'stringValue': requireThat(typeof v === 'string'); return v;
    case 'integerValue': {
      requireThat(typeof v === 'string' && /^-?\d+$/.test(v));
      const n = Number(v); requireThat(Number.isSafeInteger(n)); return n;
    }
    case 'doubleValue': requireThat(typeof v === 'number' && Number.isFinite(v) && !Object.is(v,-0)); return v;
    case 'timestampValue': return timestamp(v);
    case 'bytesValue': requireThat(typeof v === 'string' && Buffer.from(v,'base64').toString('base64') === v); return {__bytes:v};
    case 'referenceValue': {
      requireThat(typeof prefix === 'string' && typeof v === 'string' && v.startsWith(prefix+'/'));
      const ref = v.slice(prefix.length+1); segments(ref,0); return {__ref:ref};
    }
    case 'geoPointValue':
      requireThat(object(v) && Object.keys(v).every(k=>['latitude','longitude'].includes(k)) && Number.isFinite(v.latitude) && Number.isFinite(v.longitude) && Math.abs(v.latitude)<=90 && Math.abs(v.longitude)<=180);
      return {__geo:{lat:v.latitude,lng:v.longitude}};
    case 'arrayValue':
      requireThat(object(v) && Object.keys(v).every(k=>k==='values') && (v.values === undefined || Array.isArray(v.values)));
      return (v.values || []).map(x=>convertRestValue(x,prefix));
    case 'mapValue':
      requireThat(object(v) && Object.keys(v).every(k=>k==='fields'));
      requireThat(v.fields===undefined || object(v.fields));
      return convertRestFields(v.fields===undefined ? {} : v.fields,prefix);
    default: throw Error('BACKUP_REST_UNSUPPORTED_VALUE');
  }
}
export function createRestBackupApi({projectId, getCredential, fetchImpl=globalThis.fetch,
  timeoutMs=30000, maxRequests=10000, maxResponseBytes=16*1024*1024,
  maxTotalBytes=128*1024*1024, maxDocuments=50000, metadataOnly=false}) {
  requireThat(typeof metadataOnly === 'boolean');
  requireThat(projectId === 'station-102' || projectId === 'demo-resq');
  requireThat(typeof getCredential === 'function' && typeof fetchImpl === 'function');
  requireThat(Number.isInteger(timeoutMs) && timeoutMs>0 && timeoutMs<=60000);
  requireThat(Number.isInteger(maxRequests) && maxRequests>0 && maxRequests<=10000);
  requireThat(Number.isInteger(maxResponseBytes) && maxResponseBytes>0 && maxResponseBytes<=16*1024*1024);
  requireThat(Number.isInteger(maxTotalBytes) && maxTotalBytes>0 && maxTotalBytes<=128*1024*1024);
  requireThat(Number.isInteger(maxDocuments) && maxDocuments>0 && maxDocuments<=50000);
  const prefix = `projects/${projectId}/databases/(default)/documents`;
  const base = `https://firestore.googleapis.com/v1/${prefix}`;
  let requests = 0, totalBytes = 0, totalDocuments = 0;
  const seenDocuments = new Set();
  const seenPages = new Set();
  const token = t => { requireThat(t === undefined || (typeof t==='string' && t.length<=8192)); return t || undefined; };
  async function request(url, body) {
    requireThat(++requests <= maxRequests);
    const controller = new AbortController();
    let timer;
    // Deadline covers credential lookup, headers and body, including a stalled stream.
    const deadline = new Promise((_,reject)=> { timer=setTimeout(()=>{controller.abort();reject(Error('BACKUP_REST_TIMEOUT'));},timeoutMs); });
    try {
      return await Promise.race([deadline,(async()=>{
        const credential = await getCredential();
        requireThat(typeof credential?.access_token === 'string' && credential.access_token.length>0);
        if (controller.signal.aborted) throw Error('BACKUP_REST_TIMEOUT');
        const response = await fetchImpl(url,{method:body?'POST':'GET',redirect:'error',signal:controller.signal,
          headers:{Authorization:`Bearer ${credential.access_token}`,'Content-Type':'application/json'},
          ...(body?{body:JSON.stringify(body)}:{})});
        if (!response.ok) { await response.body?.cancel(); const error=Error('BACKUP_REST_HTTP'); error.code=response.status; throw error; }
        requireThat(response.body && /application\/json/i.test(response.headers.get('content-type') || ''));
        const reader=response.body.getReader(); const chunks=[]; let size=0;
        try { while(true) { const {done,value}=await reader.read(); if(done) break; size+=value.length; totalBytes+=value.length;
          if(size>maxResponseBytes || totalBytes>maxTotalBytes) { await reader.cancel(); throw Error('BACKUP_REST_RESPONSE_LIMIT'); } chunks.push(value); }
        } finally { reader.releaseLock(); }
        let result; try { result=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('BACKUP_REST_JSON'); }
        requireThat(object(result) && !result.error); return result;
      })()]);
    } finally { clearTimeout(timer); }
  }
  function location(p,parity) { return segments(p,parity).map(encodeURIComponent).join('/'); }
  return Object.freeze({
    async listCollectionPaths(parent) {
      const parentUrl = parent === undefined ? base : `${base}/${location(parent,0)}`;
      const seen=new Set(), ids=new Set(); let pageToken;
      do {
        const result=await request(`${parentUrl}:listCollectionIds`,{pageSize:100,...(pageToken?{pageToken}:{})});
        requireThat(Object.keys(result).every(k=>['collectionIds','nextPageToken'].includes(k)));
        requireThat(result.collectionIds === undefined || Array.isArray(result.collectionIds));
        for(const id of result.collectionIds || []) { requireThat(typeof id==='string' && !id.includes('/')); segments(id,1); requireThat(!ids.has(id)); ids.add(id); }
        pageToken=token(result.nextPageToken);
        if(pageToken) { requireThat(!seen.has(pageToken)); seen.add(pageToken); }
      } while(pageToken);
      return [...ids].map(id=>parent?`${parent}/${id}`:id);
    },
    async [metadataOnly ? 'listDocumentMetadata' : 'listDocuments'](collection,pageToken) {
      const encoded=location(collection,1); pageToken=token(pageToken);
      const pageKey=JSON.stringify([collection,pageToken||'']); requireThat(!seenPages.has(pageKey)); seenPages.add(pageKey);
      const query=new URLSearchParams({pageSize:'100',showMissing:'true'}); if(pageToken) query.set('pageToken',pageToken);
      if(metadataOnly) {
        query.set('mask.fieldPaths','__name__');
        query.set('fields','documents(name,createTime,updateTime),nextPageToken');
      }
      const result=await request(`${base}/${encoded}?${query}`);
      requireThat(Object.keys(result).every(k=>['documents','nextPageToken'].includes(k)));
      requireThat(result.documents === undefined || Array.isArray(result.documents));
      const seen=new Set();
      const documents=(result.documents || []).map(doc=>{
        requireThat(object(doc) && typeof doc.name==='string' && doc.name.startsWith(prefix+'/'));
        requireThat(Object.keys(doc).every(k=>['name','fields','createTime','updateTime'].includes(k)));
        requireThat(doc.fields===undefined || object(doc.fields));
        if(metadataOnly) requireThat(doc.fields === undefined);
        const p=doc.name.slice(prefix.length+1); segments(p,0);
        requireThat(p.slice(0,p.lastIndexOf('/'))===collection && !seen.has(p) && !seenDocuments.has(p)); seen.add(p); seenDocuments.add(p);
        requireThat(++totalDocuments<=maxDocuments);
        const missing=doc.createTime===undefined && doc.updateTime===undefined && doc.fields===undefined;
        if(!missing) { timestamp(doc.createTime); timestamp(doc.updateTime); }
        if(metadataOnly) return {path:p,exists:!missing};
        return {path:p,data:missing?null:convertRestFields(doc.fields===undefined ? {} : doc.fields,prefix)};
      });
      const nextPageToken=token(result.nextPageToken);
      if(nextPageToken) requireThat(!seenPages.has(JSON.stringify([collection,nextPageToken])));
      return {documents,nextPageToken};
    }
  });
}
