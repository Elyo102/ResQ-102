import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { astDigest, semanticNodes } from './mutation-ast.mjs';
const {parse}=createRequire(import.meta.url)('acorn');
export const SUITES=Object.freeze(['functions/schedule-calendar-engine.test.js',
  'functions/schedule-publication.test.js','functions/schedule-service.integration.test.js',
  'tests/schedule-calendar-source.mjs']);
export function indexSource(source){
  source=source.replace(/\r\n/g,'\n');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module',locations:true});
  const sites=semanticNodes(ast).map(row=>row.node).filter(node=>node.type==='CallExpression'
    && node.callee.type==='MemberExpression' && !node.callee.computed
    && node.callee.object.type==='Identifier' && node.callee.object.name==='assert'
    && node.callee.property.type==='Identifier').map(node=>({hash:astDigest(node),
      operator:node.callee.property.name,line:node.loc.start.line,column:node.loc.start.column,
      endLine:node.loc.end.line,endColumn:node.loc.end.column}));
  if(!sites.length)throw Error('ASSERTION_INDEX_EMPTY');
  return {sourceHash:crypto.createHash('sha256').update(source).digest('hex'),sites};
}
export function buildIndex(root){
  return {schema:1,suites:Object.fromEntries(SUITES.map(suite=>[suite,indexSource(fs.readFileSync(path.join(root,suite),'utf8'))]))};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const target=new URL('./calendar-assertion-sites.json',import.meta.url);
  const generated=JSON.stringify(buildIndex(root),null,2)+'\n';
  if(process.argv[2]==='--check'){
    if(fs.readFileSync(target,'utf8').replace(/\r\n/g,'\n')!==generated)throw Error('ASSERTION_INDEX_STALE');
  }else if(process.argv[2]==='--write')fs.writeFileSync(target,generated);
  else throw Error('ASSERTION_INDEX_REQUIRES_CHECK_OR_WRITE');
}
