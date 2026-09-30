import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from './lib/contained-playwright.cjs';
const read=n=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8');
const core=read('notification-reminder.js').replaceAll('export async function','async function').replaceAll('export function','function');
const entry=read('notification-reminder-entry.js').replace(/^import .*;\r?\n/gm,'').replace('export function','function');
const browser=await chromium.launch();
try{
 const page=await browser.newPage();await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<main></main>'}));await page.goto('https://resq.test/');
 await page.addScriptTag({content:core+`
 window.count=0;window.status='pending';window.person={uid:'owner',getIdTokenResult:async()=>({claims:{super:true}})};
 const fakeAuth={currentUser:person};const getApp=()=>({});const getAuth=()=>fakeAuth;const getFunctions=()=>({});
 const onAuthStateChanged=(a,callback)=>{window.authCallback=callback;};
 const httpsCallable=()=>async()=>{count++;return {data:{ok:true,accepted:true,status:window.status}};};
 `+entry+`;window.configure=configureNotificationReminder;window.fireAuth=()=>authCallback(fakeAuth.currentUser);`});
 await page.evaluate(()=>configure({allowed:true}));assert.equal(await page.evaluate(()=>count),0);
 await page.evaluate(()=>fireAuth());await page.waitForFunction(()=>count===1);assert.equal(await page.locator('#resqPushReminder').count(),0);
 await page.evaluate(()=>{for(let i=0;i<100;i++)configure({allowed:true});});assert.equal(await page.evaluate(()=>count),1);
 await page.evaluate(()=>{status='approved';fireAuth();});await page.locator('#resqPushReminder').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>count),2);
 await page.evaluate(()=>configure({allowed:false}));assert.equal(await page.locator('#resqPushReminder').count(),0);
 const alerts=read('alerts.html'),start=alerts.indexOf("$('btnOn').onclick = async () => {"),end=alerts.indexOf("$('btnOff').onclick",start);
 const render=alerts.slice(alerts.indexOf('function renderState(){'),alerts.indexOf('function renderDevices(){'));
 const activation=await browser.newPage();await activation.setContent('<button id="btnOn"></button><button id="btnOff"></button><div id="pState"></div><div id="pBig"></div><div id="pWhy"></div>');
 await activation.addScriptTag({content:`
 const $=id=>document.getElementById(id);let pushConfigurationEpoch=1,pushClaimPending=false,tokens=[],myToken='';
 const auth={currentUser:{uid:'one'}},MSG={},messaging={},vapid='fixture',fns={};
 window.messages=[];window.claimFails=true;window.markers=0;window.markHold=null;
 const enablePush=async()=>({ok:true,token:'fixture'}),deviceLabel=()=> 'fixture',saveTokens=async()=>{},pushSupported=()=>true,permissionState=()=> 'granted',renderDevices=()=>{};
 const msg=t=>messages.push(t),userError=(k,e,t)=>t;
 const httpsCallable=()=>async()=>{if(claimFails)throw Error('network');return {data:{evicted:0}};};
 const rememberPushConfiguration=async(uid,current)=>{if(markHold)await markHold;if(current())markers++;};
 window.switchIdentity=()=>{auth.currentUser={uid:'two'};pushConfigurationEpoch++;};
 `+render+alerts.slice(start,end)});
 await activation.evaluate(()=>document.getElementById('btnOn').onclick());assert.equal(await activation.locator('#pBig').textContent(),'נדרש אימות שיוך');assert.equal(await activation.locator('#btnOn').evaluate(e=>e.classList.contains('hide')),false);assert.equal(await activation.evaluate(()=>markers),0);
 await activation.evaluate(()=>{claimFails=false;});await activation.evaluate(()=>document.getElementById('btnOn').onclick());assert.equal(await activation.evaluate(()=>markers),1);
 await activation.evaluate(()=>{messages=[];markHold=new Promise(r=>window.release=r);window.inflight=document.getElementById('btnOn').onclick();});
 await activation.evaluate(()=>{switchIdentity();release();});await activation.evaluate(()=>window.inflight);assert.equal(await activation.evaluate(()=>markers),1);assert.deepEqual(await activation.evaluate(()=>messages),['']); // only the initial clear, before switching identity
 const readiness=read('device-readiness.html'),rs=readiness.indexOf("$('btnEnable').onclick = async () => {"),re=readiness.indexOf("$('btnSend').onclick",rs);
 const device=await browser.newPage();await device.setContent('<button id="btnEnable"></button>');
 await device.addScriptTag({content:`
 const $=id=>document.getElementById(id);let pushConfigurationEpoch=1,busy=false,tokens=[],myToken='';
 const auth={currentUser:{uid:'one'}},ME={uid:'one'},SID='eilat_102',MSG={},messaging={},vapid='fixture',db={};
 window.messages=[];window.claimFails=true;window.markers=0;window.refreshed=0;window.markHold=null;
 const enablePush=async()=>({ok:true,token:'fixture'}),deviceLabel=()=> 'fixture',setDoc=async()=>{},doc=()=>({}),serverTimestamp=()=>0,controls=()=>{},refresh=async()=>{refreshed++;};
 const msg=t=>messages.push(t),userError=(k,e,t)=>t,callClaim=async()=>{if(claimFails)throw Error('network');};
 const rememberPushConfiguration=async(uid,current)=>{if(markHold)await markHold;if(current())markers++;};
 window.switchIdentity=()=>{auth.currentUser={uid:'two'};pushConfigurationEpoch++;busy=false;};
 `+readiness.slice(rs,re)});
 await device.evaluate(()=>document.getElementById('btnEnable').onclick());assert.equal(await device.evaluate(()=>markers),0);assert.match(await device.evaluate(()=>messages.at(-1)),/לא אומת/);
 await device.evaluate(()=>{claimFails=false;messages=[];refreshed=0;markHold=new Promise(r=>window.release=r);window.inflight=document.getElementById('btnEnable').onclick();});
 await device.evaluate(()=>{switchIdentity();release();});await device.evaluate(()=>window.inflight);assert.equal(await device.evaluate(()=>markers),0);assert.equal(await device.evaluate(()=>refreshed),0);assert.deepEqual(await device.evaluate(()=>messages),['']);
 const refreshPage=await browser.newPage();await refreshPage.setContent('<main></main>');
 await refreshPage.addScriptTag({content:`let pushConfigurationEpoch=1;const auth={currentUser:{uid:'one'}};window.paints=0;const render=()=>paints++,msg=()=>paints++,userError=()=>'';const callStatus=()=>new Promise(r=>window.resolveStatus=r);`+
 readiness.slice(readiness.indexOf('async function refresh(){'),readiness.indexOf('async function loadTokens(){'))+
 `window.begin=()=>{window.pending=refresh();};window.change=()=>{pushConfigurationEpoch++;auth.currentUser={uid:'two'};resolveStatus({data:{}});};`});
 await refreshPage.evaluate(()=>window.begin());await refreshPage.evaluate(()=>window.change());await refreshPage.evaluate(()=>window.pending);assert.equal(await refreshPage.evaluate(()=>paints),0);
 console.log('Notification wiring: actual bootstrap pending/approved + 100 nav renders one check; both activation handlers partial claim/retry/stale hash PASS');
}finally{await browser.close();}
