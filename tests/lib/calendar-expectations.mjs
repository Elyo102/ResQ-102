import {createRequire} from 'node:module';
import {astDigest,semanticNodes} from './mutation-ast.mjs';
const {parse}=createRequire(import.meta.url)('acorn');
const tree=text=>parse(text,{ecmaVersion:'latest',sourceType:'module'});
const reject=code=>{throw Error('CALENDAR_EXPECTATION_'+code);};
// The caller supplies immutable source/index bytes; this function neither reads
// files nor observes mutation executions. Missing descriptors are a hard error.
export function buildExpectations(spec,descriptors,index,sources){
 const ids=descriptors.map(row=>row.id);
 if(new Set(ids).size!==ids.length || Object.keys(spec).sort().join('|')!==[...ids].sort().join('|'))reject('COVERAGE');
 return Object.fromEntries(ids.map(id=>{
  const entry=spec[id],source=sources[entry.suite],indexed=index.suites?.[entry.suite];
  if(typeof source!=='string'||!indexed||!Array.isArray(entry.sites)||!entry.sites.length)reject('SUITE');
  const ast=tree(source),nodes=semanticNodes(ast).map(row=>row.node);
  const allowed=[],required=[];
  for(const site of entry.sites){
   if(typeof site.required!=='boolean')reject('REQUIRED_FLAG');
   const tests=nodes.filter(n=>n.type==='CallExpression' && n.callee.type==='Identifier' && n.callee.name==='t'
     && n.arguments[0]?.type==='Literal' && n.arguments[0].value===site.testName);
   if(tests.length!==1 || !/Function/.test(tests[0].arguments[1]?.type||''))reject('TEST_NAME');
   const expression=tree(site.expression).body;
   if(expression.length!==1||expression[0].type!=='ExpressionStatement')reject('EXPRESSION');
   const call=expression[0].expression;
   if(call.type!=='CallExpression'||call.callee.type!=='MemberExpression'||call.callee.computed
     ||call.callee.object.name!=='assert'||call.callee.property.type!=='Identifier')reject('ASSERTION');
   const digest=astDigest(call),operator=call.callee.property.name;
   const candidates=nodes.filter(n=>n.type==='CallExpression'&&astDigest(n)===digest);
   const callback=tests[0].arguments[1];
   const inCallback=node=>node.start>=callback.start&&node.end<=callback.end;
   const direct=candidates.filter(inCallback);
   const helpers=ast.body.filter(n=>n.type==='FunctionDeclaration'&&['throwsCode','ok'].includes(n.id?.name)
     &&nodes.some(call=>inCallback(call)&&call.type==='CallExpression'&&call.callee.type==='Identifier'&&call.callee.name===n.id.name));
   const reachable=direct.concat(candidates.filter(n=>!inCallback(n)&&helpers.some(h=>n.start>=h.start&&n.end<=h.end)));
   if(reachable.length!==1||!indexed.sites.some(s=>s.hash===digest&&s.operator===operator))reject('ASSERTION_SITE');
   const stable=JSON.stringify([entry.suite,digest,operator,site.testName]);
   if(allowed.includes(stable))reject('DUPLICATE_SITE');
   allowed.push(stable);if(site.required)required.push(stable);
  }
  if(!required.length)reject('NO_REQUIRED');
  return [id,{suite:entry.suite,allowed,required}];
 }));
}
