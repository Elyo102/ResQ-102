import {classifyPath} from './ops-disaster-restore.mjs';
export async function diagnoseMetadata(api,policy,knownLabels,{maxCollections=10000,onUnknown=()=>{}}={}) {
  if(typeof api.listDocumentMetadata!=='function' || api.listDocuments) throw Error('METADATA_INTERFACE_REQUIRED');
  const seen=new Set(), gaps=new Map(); let documents=0,missingParents=0;
  async function visit(parent) {
    for(const collection of await api.listCollectionPaths(parent)) {
      if(seen.has(collection) || seen.size>=maxCollections) throw Error('DIAGNOSTIC_BOUND'); seen.add(collection);
      let token; const pages=new Set();
      do {
        const result=await api.listDocumentMetadata(collection,token);
        for(const doc of result.documents) {
          if('data' in doc || typeof doc.exists!=='boolean') throw Error('METADATA_SHAPE');
          if(doc.exists) {
            documents++;
            if(classifyPath(doc.path,policy).action==='unclassified') {
              onUnknown(doc.path);
              const pattern=doc.path.split('/').map((s,i)=>i%2?'{id}':knownLabels.has(s)?s:'{unknown_collection}').join('/');
              gaps.set(pattern,(gaps.get(pattern)||0)+1);
            }
          } else missingParents++;
          await visit(doc.path);
        }
        token=result.nextPageToken;
        if(token && pages.has(token)) throw Error('DIAGNOSTIC_PAGE_CYCLE'); if(token) pages.add(token);
      } while(token);
    }
  }
  await visit();
  return {metadataTraversalCompleted:true,pointInTimeConsistent:false,collections:seen.size,documents,missingParents,
    unclassifiedPatterns:[...gaps].map(([pattern,count])=>({pattern,count})),policyCoverageVerified:gaps.size===0};
}
