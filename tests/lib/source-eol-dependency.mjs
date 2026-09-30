import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const fail=code=>{throw Error('EOL_DEPENDENCY_'+code);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const normalize=value=>process.platform==='win32'?value.toLowerCase():value;
export const ACORN_FILES=Object.freeze([
  ['package.json','5c1ed7259579a7899b303f514b0194adcb9fe474fc7d136a84c6a45f10eefc84'],
  ['dist/acorn.mjs','953573b8fdab71599749ea5f2b33d3e760c2116178f9423ee7458dbe39d59453'],
  ['dist/acorn.js','fc3ed7b81e58464715d0291402892f22c3d86ea75302645a330390f85d8015c9'],
].map(([name,hash])=>Object.freeze({name,hash})));
function canonical(name,kind){
  if(typeof name!=='string'||!path.isAbsolute(name)||normalize(path.resolve(name))!==normalize(name))fail('PATH');
  let current=path.parse(name).root;
  for(const part of name.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink()||normalize(fs.realpathSync(current))!==normalize(current))fail('ALIAS');
  }
  const stat=fs.lstatSync(name);
  if(kind==='file'?!stat.isFile():!stat.isDirectory())fail('KIND');
  return name;
}
function inside(root,relative){
  const value=path.join(root,relative),rel=path.relative(root,value);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel))fail('ESCAPE');
  return value;
}
function readPinned(root,item){
  const filename=canonical(inside(root,item.name),'file'),bytes=fs.readFileSync(filename);
  if(sha(bytes)!==item.hash)fail('HASH');return bytes;
}
function packageShape(bytes){
  const value=JSON.parse(bytes);
  if(value.name!=='acorn'||value.version!=='8.18.0'||value.main!=='dist/acorn.js'
    ||value.exports?.['.']?.[0]?.import!=='./dist/acorn.mjs'
    ||value.exports?.['.']?.[0]?.require!=='./dist/acorn.js')fail('PACKAGE');
}
function capsuleRoot(repo){return path.join(canonical(repo,'directory'),'tests','node_modules','acorn');}
export function verifyAcornCapsule(repo){
  const root=canonical(capsuleRoot(repo),'directory');
  const names=[];
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const name=path.join(dir,entry.name);canonical(name,entry.isDirectory()?'directory':'file');
    if(entry.isDirectory())walk(name);else names.push(path.relative(root,name).split(path.sep).join('/'));
  }}
  walk(root);
  if(JSON.stringify(names.sort())!==JSON.stringify(ACORN_FILES.map(v=>v.name).sort()))fail('INVENTORY');
  for(const item of ACORN_FILES){const bytes=readPinned(root,item);if(item.name==='package.json')packageShape(bytes);}
  return root;
}
export function installAcornCapsule(sourceRepo,destinationRepo){
  canonical(sourceRepo,'directory');canonical(destinationRepo,'directory');
  const lock=JSON.parse(fs.readFileSync(canonical(path.join(sourceRepo,'tests','package-lock.json'),'file'),'utf8'));
  const entry=lock.packages?.['node_modules/acorn'];
  if(entry?.version!=='8.18.0'||entry.resolved!=='https://registry.npmjs.org/acorn/-/acorn-8.18.0.tgz'
    ||entry.integrity!=='sha512-lGq+9yr1/GuAWaVYIHRjvvySG5/4VfKIvC8EWxStPdcDh/Ka7FG3twP6v4d5BkravUilhIAsG4Qj83t02LWUPQ==')fail('LOCK');
  const source=canonical(capsuleRoot(sourceRepo),'directory');
  const copied=ACORN_FILES.map(item=>({item,bytes:readPinned(source,item)}));
  packageShape(copied[0].bytes);
  const tests=canonical(path.join(destinationRepo,'tests'),'directory');
  const modules=path.join(tests,'node_modules');
  if(fs.existsSync(modules))fail('DESTINATION_EXISTS');
  fs.mkdirSync(modules);canonical(modules,'directory');
  const destination=path.join(modules,'acorn');fs.mkdirSync(destination);fs.mkdirSync(path.join(destination,'dist'));
  for(const {item,bytes} of copied)fs.writeFileSync(inside(destination,item.name),bytes,{flag:'wx'});
  return verifyAcornCapsule(destinationRepo);
}
export function verifyAcornImport(repo){
  const root=verifyAcornCapsule(repo);
  const expected=pathToFileURL(path.join(root,'dist','acorn.mjs')).href;
  const program="import {version,parse} from 'acorn';if(import.meta.resolve('acorn')!==process.argv[1]||version!=='8.18.0'||parse('const x=1',{ecmaVersion:2022}).body.length!==1)throw Error('EOL_IMPORT');console.log('EOL_LOCAL_ACORN_OK');";
  let output;
  try{output=execFileSync(process.execPath,['--input-type=module','-e',program,expected],{
    cwd:path.join(repo,'tests'),encoding:'utf8',timeout:10000,maxBuffer:8192,stdio:['ignore','pipe','pipe']});}
  catch{fail('IMPORT');}
  if(output.trim()!=='EOL_LOCAL_ACORN_OK')fail('IMPORT_OUTPUT');
  verifyAcornCapsule(repo);
}
