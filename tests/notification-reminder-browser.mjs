import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from './lib/contained-playwright.cjs';
const source=fs.readFileSync(new URL('../notification-reminder.js',import.meta.url),'utf8').replaceAll('export async function','async function').replaceAll('export function','function');
const browser=await chromium.launch();
try{
 const page=await browser.newPage();await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<main>Fixture</main>'}));await page.goto('https://resq.test/');
 await page.addScriptTag({content:source+`
 window.checks=0;window.accepted=true;window.ready=false;window.env={supported:true,denied:false,ios:false,standalone:false};
 window.mount=()=>{window.controller?.stop();sessionStorage.clear();window.controller=createNotificationReminder({verify:async()=>{checks++;if(window.hold)await window.hold;return accepted;},configured:async()=>ready,environment:()=>env});};
 window.enter=(uid='owner',session='one',allowed=true)=>controller.enter({uid,session,allowed,href:'./device-readiness.html'});window.mount();`});
 await page.evaluate(()=>enter());assert.equal(await page.locator('#resqPushReminder').count(),1);
 await page.evaluate(()=>enter());assert.equal(await page.evaluate(()=>checks),1);
 await page.getByRole('button',{name:'לא עכשיו'}).click();await page.evaluate(()=>enter());assert.equal(await page.locator('#resqPushReminder').count(),0);
 await page.evaluate(()=>{mount();accepted=false;});await page.evaluate(()=>enter());assert.equal(await page.locator('#resqPushReminder').count(),0);
 await page.evaluate(()=>{mount();accepted=true;ready=true;});await page.evaluate(()=>enter());assert.equal(await page.locator('#resqPushReminder').count(),0);
 await page.evaluate(()=>{mount();ready=false;document.body.insertAdjacentHTML('beforeend','<div id="coWrap" class="on"></div>');});await page.evaluate(()=>enter());assert.equal(await page.locator('#resqPushReminder').count(),0);
 await page.evaluate(()=>document.getElementById('coWrap').classList.remove('on'));await page.locator('#resqPushReminder').waitFor({state:'visible'});
 await page.evaluate(()=>document.getElementById('coWrap').classList.add('on'));await page.locator('#resqPushReminder').waitFor({state:'hidden'});
 await page.evaluate(()=>{document.getElementById('coWrap').remove();mount();window.hold=new Promise(r=>window.release=r);window.pending=enter();});
 await page.evaluate(()=>{controller.stop();window.release();});await page.evaluate(()=>window.pending);assert.equal(await page.locator('#resqPushReminder').count(),0);
 for(const [env,text] of [[{supported:true,denied:true},'ההרשאה חסומה'],[{supported:true,ios:true,standalone:false},'הוסף למסך הבית'],[{supported:false},'אינו תומך']]){
   await page.evaluate(e=>{window.hold=null;env=e;mount();},env);await page.evaluate(()=>enter());assert.match(await page.locator('#resqPushReminder').textContent(),new RegExp(text));
 }
 await page.evaluate(()=>{
  controller.stop();window.endpoint='https://push.test/one';Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistration:async()=>({scope:location.origin+'/',pushManager:{getSubscription:async()=>({endpoint})}})}});
  Object.defineProperty(window,'Notification',{configurable:true,value:{permission:'granted'}});clearPushConfiguration();
 });
 await page.evaluate(()=>rememberPushConfiguration('owner',()=>false));assert.equal(await page.evaluate(()=>configuredPushDevice('owner')),false);
 await page.evaluate(()=>rememberPushConfiguration('owner',()=>true));assert.equal(await page.evaluate(()=>configuredPushDevice('owner')),true);
 assert.equal(await page.evaluate(()=>configuredPushDevice('other')),false);
 assert.equal(await page.evaluate(()=>localStorage.getItem('resq.push-config.v1').includes('push.test')),false);
 await page.evaluate(()=>window.endpoint='https://push.test/two');assert.equal(await page.evaluate(()=>configuredPushDevice('owner')),false);
 await page.evaluate(()=>clearPushConfiguration());assert.equal(await page.evaluate(()=>configuredPushDevice('owner')),false);
 console.log('Notification reminder: terms gate, coalescing, dismissal, configured device, callout priority, stale identity, denied/iOS/unsupported, hashed subscription PASS');
}finally{await browser.close();}
