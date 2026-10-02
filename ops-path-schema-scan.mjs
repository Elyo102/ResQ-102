// Conservative static inventory: never executes source or claims dynamic completeness.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('./tests/package.json',import.meta.url));
const {parse}=require('acorn');
export function scanSource(source, file='source.js') {
  const findings=[], unresolved=[]; let ast;
  try { ast=parse(source,{ecmaVersion:'latest',sourceType:'module',locations:true,allowReturnOutsideFunction:true}); }
  catch { return {findings,unresolved:[{file,kind:'parse_failure'}]}; }
  const nodes=[], bindings=new Map(), aliases=new Map([['doc','doc'],['collection','collection']]);
  function walk(n) { if(!n || typeof n!=='object') return; if(n.type) nodes.push(n);
    for(const [key,value] of Object.entries(n)) if(key!=='loc') { if(Array.isArray(value)) value.forEach(walk); else if(value?.type) walk(value); } }
  walk(ast);
  for(const n of nodes) {
    if(n.type==='ImportSpecifier' && ['doc','collection'].includes(n.imported.name)) aliases.set(n.local.name,n.imported.name);
    if(n.type==='VariableDeclarator' && n.id.type==='Identifier') {
      if(bindings.has(n.id.name)) bindings.set(n.id.name,null); else bindings.set(n.id.name,n.init);
    }
  }
  const prop=n=>n?.type==='MemberExpression' ? (n.computed ? (n.property.type==='Literal'?n.property.value:null) : n.property.name) : null;
  function kind(n,seen=new Set()) {
    if(n?.type==='MemberExpression') return ['doc','collection'].includes(prop(n))?prop(n):null;
    if(n?.type==='Identifier') {
      if(aliases.has(n.name)) return aliases.get(n.name);
      if(seen.has(n.name)) return null; seen.add(n.name); return kind(bindings.get(n.name),seen);
    } return null;
  }
  function value(n,seen=new Set(),depth=0) {
    if(!n || depth>30) return '{?}';
    if(n.type==='Literal' && typeof n.value==='string') return n.value;
    if(n.type==='TemplateLiteral') return n.quasis.map((q,i)=>q.value.cooked+(i<n.expressions.length?value(n.expressions[i],new Set(seen),depth+1):'')).join('');
    if(n.type==='BinaryExpression' && n.operator==='+') return value(n.left,new Set(seen),depth+1)+value(n.right,new Set(seen),depth+1);
    if(n.type==='Identifier') {
      if(seen.has(n.name)) return '{?}'; seen.add(n.name);
      return value(bindings.get(n.name),seen,depth+1);
    }
    if(n.type==='CallExpression' && kind(n.callee)) {
      const member=n.callee.type==='MemberExpression';
      const base=member?n.callee.object:n.arguments[0];
      const isRoot=base?.type==='Identifier' && /^(db|firestore)$/.test(base.name);
      const parts=[isRoot?'':value(base,new Set(seen),depth+1),...n.arguments.slice(member?0:1).map(a=>value(a,new Set(seen),depth+1))];
      return parts.filter(Boolean).join('/');
    }
    return '{?}';
  }
  for(const n of nodes) if(n.type==='CallExpression') {
    const k=kind(n.callee);
    if(k) {
      const pattern=value(n); findings.push({file,line:n.loc.start.line,kind:k,pattern});
      if(pattern.includes('{?}')) unresolved.push({file,line:n.loc.start.line,kind:'dynamic_path_or_parent'});
    } else if(n.callee.type==='MemberExpression' && n.callee.computed) unresolved.push({file,line:n.loc.start.line,kind:'computed_call_not_resolved'});
    else if(n.callee.type==='Identifier' && /(?:ref|path|doc|collection)/i.test(n.callee.name)) unresolved.push({file,line:n.loc.start.line,kind:'possible_wrapper_not_resolved'});
  }
  return {findings,unresolved};
}
export function scanRepository(root) {
  const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(f=>/\.(?:js|mjs|cjs|ts|tsx|jsx|html)$/.test(f));
  const findings=[],unresolved=[];
  for(const file of files) {
    const source=fs.readFileSync(path.join(root,file),'utf8');
    const scripts=file.endsWith('.html') ? [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].flatMap(m=>{
      if(/\bsrc\s*=/i.test(m[1])) { unresolved.push({file,kind:'external_script_reference_tracked_files_scanned_separately'});return []; }
      if(/type\s*=\s*["'](?:application\/ld\+json|application\/json)/i.test(m[1])) return [];
      return [m[2]];
    }) : [source];
    for(const [index,script] of scripts.entries()) { const r=scanSource(script,file.endsWith('.html')?`${file}#script${index}`:file); findings.push(...r.findings);unresolved.push(...r.unresolved); }
  }
  return {filesScanned:files.length,completeDynamicCoverage:false,limitations:['lexical bindings, not scope-aware','unknown wrappers and computed dispatch unresolved','TypeScript/JSX parse failures retained','HTML script lines relative to script'],findings,unresolved};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=scanRepository(path.dirname(fileURLToPath(import.meta.url)));
  // Source patterns can contain identifiers; emit counts only by default.
  console.log(JSON.stringify({filesScanned:result.filesScanned,findings:result.findings.length,unresolved:result.unresolved.length,completeDynamicCoverage:false}));
}
