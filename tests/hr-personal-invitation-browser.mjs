import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from './lib/contained-playwright.cjs';
const root=new URL('../',import.meta.url);
const link=fs.readFileSync(new URL('invitation-link.js',root),'utf8').replaceAll('export function','function');
const ui=fs.readFileSync(new URL('hr-invitation-ui.js',root),'utf8').replace(/^import[^\n]+\n/,'').replace('export function','function');
const browser=await chromium.launch();
try {
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<main id="root"></main>'}));
  await page.goto('http://resq.test/admin.html');
  await page.addScriptTag({content:link+'\n'+ui+`
    let uid='owner', count=0, serial=0; window.calls=[];window.fail=false;window.hold=null;window.existing=false;
    window.mount=()=>{window.dispose?.();window.dispose=mountHrInvitation(document.getElementById('root'),{
      getActor:()=>uid,requestId:()=> 'request_00000000'+(++serial),stationOptions:'<option value="eilat_102">אילת</option>',
      issue:async payload=>{calls.push(payload);if(window.hold)await window.hold;if(window.fail){window.fail=false;throw Error('רשת');}
        return {ok:true,invite_id:'invite_0000000000001',secret_available:!window.existing,secret:'a'.repeat(40)};},
      revoke:async payload=>{calls.push(payload);return {ok:true};}
    });};window.switchUser=()=>{uid='other';window.dispose();};window.mount();`});
  const name=page.locator('[data-field=name]'), email=page.locator('[data-field=email]'), issue=page.locator('[data-action=issue]');
  await name.fill('ליסה');await email.fill('lisaa@example.test');
  await page.evaluate(()=>window.fail=true);await issue.click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('רשת'));
  await issue.click();await page.waitForFunction(()=>document.querySelector('[data-link]').value.includes('#invite='));
  assert.equal(await issue.isDisabled(),true);assert.equal(await page.evaluate(()=>JSON.stringify(calls[0])===JSON.stringify(calls[1])),true);
  const known=await page.locator('[data-link]').inputValue();await issue.dispatchEvent('click');assert.equal(await page.locator('[data-link]').inputValue(),known);
  await page.locator('[data-action=new]').click();assert.equal(await name.inputValue(),'');assert.equal(await email.inputValue(),'');
  assert.equal(await page.evaluate(()=>calls.length),2);
  await page.evaluate(()=>{window.existing=true;window.mount();});await name.fill('ליסה');await email.fill('lisaa@example.test');await issue.click();
  await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('כבר קיימת'));
  assert.equal(await page.locator('[data-action=revoke]').isVisible(),true);assert.equal(await page.locator('[data-link-box]').isVisible(),false);
  await page.locator('[data-action=revoke]').click();await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('בוטלה'));
  assert.equal(await issue.isEnabled(),true);
  await page.evaluate(()=>{window.hold=new Promise(r=>window.release=r);window.existing=false;});await issue.click();
  await page.evaluate(()=>{window.switchUser();window.release();});assert.equal(await page.locator('#root').textContent(),'');
  console.log('HR invitation browser: retry, duplicate click, new recipient, recovery, revoke and identity cleanup PASS');
}finally{await browser.close();}
