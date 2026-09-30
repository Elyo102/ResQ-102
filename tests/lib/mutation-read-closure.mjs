import path from 'node:path';
import { builtinModules } from 'node:module';
import { parse } from 'acorn';
const UNKNOWN = Symbol('unknown');
const builtin = new Set(builtinModules.map(name => name.replace(/^node:/,'')));
const reads = new Set(['readFileSync','readFile','createReadStream','open','openSync','read','readSync','readv','readvSync']);
const fail = () => { throw Object.assign(Error('MUTATION_READ_UNRESOLVED'),{code:'UNRESOLVED_FILE_READ'}); };
class Scope {
  constructor(parent = null) { this.parent = parent; this.values = new Map(); }
  get(name) { return this.values.has(name) ? this.values.get(name) : this.parent ? this.parent.get(name) : UNKNOWN; }
  set(name,value) { this.values.set(name,value); }
  assign(name,value) { if (this.values.has(name) || !this.parent) this.set(name,value); else this.parent.assign(name,value); }
}
// Deliberately limited static language, not a general JavaScript interpreter.
// Unknown paths, dynamic filesystem properties and escaping filesystem values
// fail closed. Dependencies use normalized manifest-relative POSIX paths.
export function verifyReadClosure(records) {
  const names = new Map(records.map(row => [row.name,row]));
  const dependencies = new Map();
  for (const row of records) {
    if (row.role === 'read-only-source' || row.role === 'parent-data') continue;
    const tree = parse(row.bytes.toString(), {ecmaVersion:'latest',sourceType:'module'});
    const here = path.posix.dirname(row.name), global = new Scope(), functions = new Set(), invoked = new Set(), active = new Set();
    global.set('require',{kind:'require'}); global.set('__dirname',here);
    function dependency(name,kind) {
      if (typeof name !== 'string') fail();
      let resolved;
      if (kind === 'module') {
        const bare = name.replace(/^node:/,'');
        if (builtin.has(bare)) return ['fs','fs/promises'].includes(bare)?{kind:'fs'}:bare==='path'?{kind:'path'}:bare==='url'?{kind:'url'}:UNKNOWN;
        if (!name.startsWith('.')) fail();
        resolved=path.posix.normalize(path.posix.join(here,name));
        if (!names.has(resolved) && names.has(resolved+'.js')) resolved+='.js';
      } else resolved=path.posix.normalize(name);
      const record=names.get(resolved);
      if (!record || record.role==='parent-data' || (kind==='module' && record.role==='read-only-source')) fail();
      dependencies.set(row.name+'\0'+resolved+'\0'+kind,{from:row.name,path:resolved,kind});
      return UNKNOWN;
    }
    function key(node,scope,depth) { return node.computed ? value(node.property,scope,depth+1) : node.property.name; }
    function member(object,property) {
      if(['read','require','fileURL','pathFunction'].includes(object?.kind))fail();
      if (object?.kind==='fs') { if(typeof property!=='string')fail(); if(property==='promises')return object; if(reads.has(property))return {kind:'read'}; return UNKNOWN; }
      if(object?.kind==='path' && ['join','resolve','dirname'].includes(property))return {kind:'pathFunction',name:property};
      if(object?.kind==='url' && property==='fileURLToPath')return {kind:'fileURL'};
      return UNKNOWN;
    }
    function bind(pattern,result,scope) {
      if(pattern.type==='Identifier')scope.set(pattern.name,result);
      else if(pattern.type==='ObjectPattern')for(const prop of pattern.properties){if(prop.type!=='Property') { if(result?.kind)fail(); continue; }const property=prop.computed?value(prop.key,scope):prop.key.name??prop.key.value;bind(prop.value,member(result,property),scope);}
      else if(pattern.type==='AssignmentPattern')bind(pattern.left,result,scope);
      else if(result!==UNKNOWN)fail();
    }
    function value(node,scope,depth=0) {
      if(!node)return UNKNOWN;if(depth>256)fail();
      if(node.type==='Literal')return node.value;
      if(node.type==='Identifier')return scope.get(node.name);
      if(node.type==='MetaProperty')return {kind:'importMeta'};
      if(node.type==='TemplateLiteral'){let text=node.quasis[0].value.cooked;for(let i=0;i<node.expressions.length;i++){const item=value(node.expressions[i],scope,depth+1);if(typeof item!=='string')return UNKNOWN;text+=item+node.quasis[i+1].value.cooked;}return text;}
      if(node.type==='BinaryExpression'){const left=value(node.left,scope,depth+1),right=value(node.right,scope,depth+1);return node.operator==='+'&&typeof left==='string'&&typeof right==='string'?left+right:UNKNOWN;}
      if(node.type==='MemberExpression'){const object=value(node.object,scope,depth+1),property=key(node,scope,depth);if(object?.kind==='importMeta'&&property==='url')return row.name;return member(object,property);}
      if(node.type==='ArrowFunctionExpression'||node.type==='FunctionExpression'){const fn={kind:'function',node,scope};functions.add(fn);return fn;}
      if(node.type==='AssignmentExpression'){const result=value(node.right,scope,depth+1);if(node.left.type==='Identifier')scope.assign(node.left.name,result);else if(result?.kind)fail();return result;}
      if(node.type==='ObjectExpression'||node.type==='ArrayExpression'){
        const entries=node.type==='ArrayExpression'?node.elements:node.properties.map(prop=>prop.type==='Property'?prop.value:prop.argument);
        for(const entry of entries){const item=value(entry,scope,depth+1);if(item?.kind&&item.kind!=='function')fail();}
        return UNKNOWN;
      }
      if(node.type==='ImportExpression')return dependency(value(node.source,scope,depth+1),'module');
      if(node.type==='CallExpression') {
        const callee=value(node.callee,scope,depth+1),args=node.arguments.map(arg=>value(arg,scope,depth+1));
        if(callee?.kind==='require')return dependency(args[0],'module');
        if(callee?.kind==='read'){dependency(args[0],'read');return UNKNOWN;}
        if(callee?.kind==='fileURL')return args[0];
        if(callee?.kind==='pathFunction'){if(args.some(arg=>typeof arg!=='string'))return UNKNOWN;return callee.name==='dirname'?path.posix.dirname(args[0]):path.posix.join(...args);}
        if(callee?.kind==='function')return invoke(callee,args,depth+1);
        const method=node.callee.type==='MemberExpression'?key(node.callee,scope,depth):node.callee.name;
        if(reads.has(method)||['eval','Function'].includes(method)||args.some(arg=>arg?.kind&&arg.kind!=='function'))fail();
        return UNKNOWN;
      }
      if(node.type==='AwaitExpression')return value(node.argument,scope,depth+1);
      for(const item of Object.values(node))if(item&&typeof item==='object'){if(Array.isArray(item))item.forEach(child=>child?.type&&value(child,scope,depth+1));else if(item.type)value(item,scope,depth+1);}
      return UNKNOWN;
    }
    function invoke(callee,args,depth=0){
      if(active.has(callee.node))return UNKNOWN;
      invoked.add(callee.node);active.add(callee.node);
      try {const fn=callee.node,child=new Scope(callee.scope);fn.params.forEach((param,i)=>bind(param,args[i]??UNKNOWN,child));
        if(fn.body.type!=='BlockStatement')return value(fn.body,child,depth+1);
        statements(fn.body.body,child);const returns=fn.body.body.filter(item=>item.type==='ReturnStatement');
        return returns.length===1?value(returns[0].argument,child,depth+1):UNKNOWN;
      }finally{active.delete(callee.node);}
    }
    function statements(nodes,scope) {
      for(const node of nodes){if(node.type==='VariableDeclaration')for(const item of node.declarations)bind(item.id,UNKNOWN,scope);else if(node.type==='FunctionDeclaration'){const fn={kind:'function',node,scope};functions.add(fn);scope.set(node.id.name,fn);}}
      for(const node of nodes){
        if(node.type==='ImportDeclaration'){const imported=dependency(node.source.value,'module');for(const spec of node.specifiers)scope.set(spec.local.name,spec.type==='ImportSpecifier'?member(imported,spec.imported.name):imported);}
        else if(node.type==='VariableDeclaration')for(const item of node.declarations)bind(item.id,value(item.init,scope),scope);
        else if(node.type==='FunctionDeclaration')continue;
        else if(node.type==='ExportNamedDeclaration'||node.type==='ExportDefaultDeclaration'){if(node.source)dependency(node.source.value,'module');if(node.declaration)statements([node.declaration],scope);}
        else if(node.type==='BlockStatement')statements(node.body,new Scope(scope));
        else if(node.type==='IfStatement'){value(node.test,scope);for(const branch of [node.consequent,node.alternate])if(branch)statements(branch.type==='BlockStatement'?branch.body:[branch],new Scope(scope));}
        else if(node.type==='ExpressionStatement')value(node.expression,scope);
        else if(node.type==='TryStatement'){statements(node.block.body,new Scope(scope));if(node.handler){const child=new Scope(scope);if(node.handler.param)bind(node.handler.param,UNKNOWN,child);statements(node.handler.body.body,child);}if(node.finalizer)statements(node.finalizer.body,new Scope(scope));}
        else value(node,scope);
      }
    }
    statements(tree.body,global);
    // Analyze declared function bodies too: uncalled or externally called file
    // readers with unresolved arguments are unsupported rather than omitted.
    for(const item of functions)if(!invoked.has(item.node))invoke(item,[]);
  }
  return [...dependencies.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
