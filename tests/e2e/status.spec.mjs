import { test, expect } from '../lib/contained-test.mjs';
import { readFileSync } from 'node:fs';
const base = new URL('../../public/status/', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('snapshot.json',base),'utf8'));
async function mount(page, data=fixture) {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/*', async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='http://localhost:41996'){await route.abort();return;}
    const file=url.pathname.split('/').pop()||'index.html';
    if(file==='snapshot.json'){await route.fulfill({json:data});return;}
    if(!['index.html','status.js','status.css'].includes(file)){await route.fulfill({status:404,body:''});return;}
    await route.fulfill({body:readFileSync(new URL(file,base)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('http://localhost:41996/ResQ-102/status/');return errors;
}
test('status cards, filters, pause and clear are presentation-only',async({page})=>{
  const errors=await mount(page);await expect(page.locator('.agent')).toHaveCount(4);
  await expect(page.locator('#terminal .entry')).toHaveCount(2);
  await page.getByRole('button',{name:'Grok',exact:true}).click();await expect(page.locator('#terminal')).toContainText('No events');
  await page.getByRole('button',{name:'All Agents'}).click();await expect(page.locator('#terminal .entry')).toHaveCount(2);
  await page.getByRole('button',{name:'Pause',exact:true}).click();await expect(page.locator('#freshness')).toContainText('Paused');
  await page.getByRole('button',{name:'Clear',exact:true}).click();await expect(page.locator('#terminal .entry')).toHaveCount(0);await expect(page.locator('.agent')).toHaveCount(4);
  await page.getByRole('button',{name:'Resume'}).click();await expect(page.locator('#terminal .entry')).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('touch targets and layout at narrow and wide screens',async({page},info)=>{
  const errors=await mount(page);await expect(page.locator('.agent')).toHaveCount(4);
  for(const width of [320,390,1440]){await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for(const button of await page.locator('button').all()){const rect=await button.boundingBox();expect(rect.height).toBeGreaterThanOrEqual(44);}
  }
  await page.screenshot({path:info.outputPath('status-desktop.png'),fullPage:true});expect(errors).toEqual([]);
});
test('stale snapshots remain visibly stale and text is not executable',async({page})=>{
  const data=structuredClone(fixture);data.updated_at='2020-01-01T00:00:00Z';data.logs[0].message='<img src=x onerror=alert(1)>';
  const errors=await mount(page,data);await expect(page.locator('#freshness')).toContainText('Stale');await expect(page.locator('#terminal')).toContainText('<img');await expect(page.locator('#terminal img')).toHaveCount(0);expect(errors).toEqual([]);
});
test('invalid data fails visibly without inventing active agents',async({page})=>{
  const errors=await mount(page,{schema:1});await expect(page.locator('#freshness')).toContainText('unavailable');await expect(page.locator('.agent')).toHaveCount(0);await expect(page.locator('#terminal')).toContainText('No activity is assumed');expect(errors).toEqual([]);
});
test('pause and resume preserve known unavailable state and last data',async({page})=>{
  await page.clock.install();const errors=await mount(page);await expect(page.locator('.agent')).toHaveCount(4);
  await page.route('**/snapshot.json',route=>route.fulfill({json:{schema:1}}));
  await page.clock.runFor(60001);await expect(page.locator('#freshness')).toContainText('unavailable');
  await page.getByRole('button',{name:'Pause',exact:true}).click();await expect(page.locator('#freshness')).toContainText('unavailable');
  await page.getByRole('button',{name:'Resume'}).click();await expect(page.locator('#freshness')).toContainText('unavailable');
  await expect(page.locator('.agent')).toHaveCount(4);expect(errors).toEqual([]);
});
