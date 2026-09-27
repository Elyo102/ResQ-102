import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const source=fs.readFileSync(new URL('../owner-setup-mail-ui.js',import.meta.url),'utf8').replace('export function','function');
const browser=await chromium.launch();
try{
  const page=await browser.newPage();await page.setContent('<main id="root"></main>');
  await page.addScriptTag({content:source+`
    window.calls=[];window.fail=false;window.uid='owner';window.serial=0;
    window.api=mountSetupMail(document.getElementById('root'),{getActor:()=>uid,requestId:()=> 'mail_request_00000'+(++serial),call:async d=>{
      calls.push(structuredClone(d));if(window.hold)await window.hold;if(window.fail){window.fail=false;throw Error('network');}
      return {ok:true,rows:d.uids.map(uid=>d.action==='preview'?{uid,eligible:true,email:uid+'@example.test',emp:17,station_id:'eilat_102',full_name:uid,fingerprint:'a'.repeat(64)}:{uid,state:'PENDING'})};
    }});api.setUsers([{uid:'one',full_name:'One',email:'one@example.test',claims:{emp:17}},{uid:'two',full_name:'Two',email:'two@example.test',claims:{emp:18}}]);`});
  const select=page.locator('[data-users]'),preview=page.locator('[data-preview]'),send=page.locator('[data-send]');
  await select.selectOption('one');await preview.click();await send.waitFor({state:'visible'});
  await page.evaluate(()=>window.fail=true);await send.click();await page.waitForFunction(()=>document.querySelector('[data-results]').textContent.includes('לא אומתה'));
  await send.click();await page.waitForFunction(()=>document.querySelector('[data-results]').textContent.includes('בתור'));
  assert.deepEqual(await page.evaluate(()=>calls[1]),await page.evaluate(()=>calls[2]));
  await page.locator('[data-new]').click();assert.equal(await select.isEnabled(),true);
  assert.match(await page.locator('[data-history]').textContent(),/אינה מבטלת/);
  await page.locator('[data-history] button').first().click();
  assert.equal(await page.evaluate(()=>calls[3].request_id),await page.evaluate(()=>calls[1].request_id));
  await select.selectOption('two');await preview.click();await send.click();
  assert.notEqual(await page.evaluate(()=>calls.at(-1).request_id),await page.evaluate(()=>calls[1].request_id));
  await page.evaluate(()=>{window.hold=new Promise(r=>window.release=r);});await page.locator('[data-status]').click();
  await page.evaluate(()=>{uid='other';api.dispose();window.release();});assert.equal(await page.locator('#root').textContent(),'');
  console.log('Owner setup mail browser: uncertain retry, batch history, second batch and identity cleanup PASS');
}finally{await browser.close();}
