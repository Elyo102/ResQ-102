import assert from 'node:assert/strict';
import {messageTimeMs} from '../bulletin.js';

const ms=Date.parse('2026-10-02T07:00:00.123Z');
const throwing=()=>{throw Error('synthetic conversion failure');};
const getter=Object.defineProperty({},'toMillis',{get:throwing});
const cases=[
  ['numeric overflow',1e20,0],['negative overflow',-1e20,0],
  ['above endpoint',8.64e15+1,0],['below endpoint',-8.64e15-1,0],
  ['positive endpoint',8.64e15,8.64e15],['negative endpoint',-8.64e15,-8.64e15],
  ['seconds overflow',{seconds:1e17},0],['seconds coercion',{seconds:{toString:1}},0],
  ['nanoseconds coercion',{seconds:1,nanoseconds:{toString:1}},0],
  ['throwing millis',{toMillis:throwing},0],['throwing date',{toDate:throwing},0],
  ['throwing getter',getter,0],['malformed string',{toString:1},0],
  ['NaN',NaN,0],['Infinity',Infinity,0],['invalid date',new Date(NaN),0],
  ['millis method overflow',{toMillis:()=>1e20},0],
  ['valid timestamp',{toMillis:()=>ms},ms],['valid toDate',{toDate:()=>new Date(ms)},ms],
  ['valid seconds',{seconds:Math.floor(ms/1000),nanoseconds:123000000},ms],
  ['valid Date',new Date(ms),ms],['valid number',ms,ms],
  ['valid ISO',new Date(ms).toISOString(),ms],['fractional millis',1234.5,1234.5],
  ['missing',undefined,0],['epoch',0,0]
];
let failed=0;
for(const [name,value,expected] of cases){
  try{const actual=messageTimeMs(value);assert.equal(actual,expected);
    if(actual)assert.doesNotThrow(()=>new Date(actual).toISOString());
    console.log('PASS '+name);
  }catch(error){failed++;console.error('FAIL '+name+': '+(error.code||error.name));}
}
const fallback=messageTimeMs(1e20)||messageTimeMs(new Date(ms).toISOString());
if(fallback!==ms){failed++;console.error('FAIL valid created_key fallback');}
else console.log('PASS valid created_key fallback');
console.log(`Bulletin time boundaries: ${cases.length+1-failed}/${cases.length+1} PASS`);
if(failed)process.exitCode=1;
