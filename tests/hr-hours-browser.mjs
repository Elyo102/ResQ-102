import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=await chromium.launch();
let passed=0;
const origin='http://127.0.0.1:41992';
async function fixture({width=1100,theme='light',connected=true}={}) {
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,serviceWorkers:'block'});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
    const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
    let body=fs.readFileSync(file);
    if(file.endsWith('hr-client.js'))body="import { createHrHoursUI } from './hr-hours-ui.js?v=42h9'; window.__UI=createHrHoursUI(document.getElementById('hr-workspace')"+(connected?',window.__adapter':'')+");";
    await route.fulfill({status:200,contentType:file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript',body});
  });
  await context.addInitScript(()=>{
    window.__session={uid:'hr.fixture',stationId:'fixture_station',role:'hr_coordinator',super:false,epoch:1};
    window.__listeners=[];window.__calls=[];window.__held=[];window.__holdDetails=false;window.__holdLists=false;
    window.__people=[{uid:'u1',full_name:'עובד ראשון',state:'draft',historical:false,reminder_eligible:true},{uid:'u2',full_name:'עובד שני',state:'approved',historical:false,reminder_eligible:false},{uid:'u3',full_name:'עובד לשעבר',state:'draft',historical:true,reminder_eligible:false}];
    window.__registered=[];window.__historyRows=null;window.__children=[];window.__requestCount=0;
    // Synthetic receipt transport; this suite exercises the actual DOM controller,
    // not Firestore, callable authorization, quota enforcement or notification delivery.
    const digest=crypto.subtle.digest.bind(crypto.subtle);
    window.__nativeDigest=digest;window.__reviews=[];
    window.__makeAction=(data,id='a'.repeat(64))=>({action_id:id,station_id:__session.stationId,month:data.month,audience:data.uid?'person':'station',
      status:__quiet&&!data.send_now?'confirmation_required':data.uid?'completed':'discovering',reason:__quiet&&!data.send_now?'manual-quiet-hours-warning':null,
      counts:{scanned:data.uid&&!(__quiet&&!data.send_now)?1:0,queued:data.uid&&!(__quiet&&!data.send_now)?1:0,suppressed:0,skipped:0,invalid:0},created_at_ms:1800000000000,expires_at_ms:1800003600000,not_before_ms:null,
      phase:data.uid?'person':'discovery',discovery_scanned:0,delivery_status:'intent_only',audience_semantics:data.uid?'active_when_requested':'active_when_enqueue_page_scanned_with_completed_discovery_uid_upper_bound'});
    window.__quiet=false;
    window.__rich=(data,id)=>({...__makeAction(data,id),recipient_uid:data.uid||null,updated_at_ms:1800000000000,status_scope:'generation_only'});
    window.__makeChild=(id,recipient='u1',status='queued',outcome=null)=>({id,recipient_uid:recipient,type:'report_confirm',dispatch_type:null,status,reason:null,terminal:false,
      created_at_ms:1800000000000,expires_at_ms:1800003600000,updated_at_ms:null,finished_at_ms:null,not_before_ms:null,next_check_ms:null,outcome_counts:outcome,delivery_status:outcome?'provider_outcome_only':'intent_only'});
    window.__adapter={currentSession:()=>window.__session,subscribeIdentity:cb=>{window.__listeners.push(cb);return()=>{};},
      listMonth:async data=>{
        window.__calls.push({name:'list',data});
        const result={month:data.month,items:structuredClone(window.__people),next_cursor:window.__cursor||null};
        if(window.__holdLists)return new Promise(resolve=>window.__held.push({kind:'list',resolve:()=>resolve(result)}));
        return result;
      },
      clearReportCache:()=>{window.__cacheClears=(window.__cacheClears||0)+1;},
      getEmployeeMonth:async (data,options={})=>{
        window.__calls.push({name:'detail',data,options});
        if(window.__failReviewRefresh&&options.forceFresh&&__reviews.length)throw Object.assign(new Error('synthetic refresh failure'),{code:'functions/unavailable'});
        const person=window.__people.find(p=>p.uid===data.uid);
        const result={...person,month:data.month,employee_number:'1001',crew:'A',stored_total_hours:24,current_detail_total_hours:22,
          warnings:['reported-total-differs'],rows:window.__emptyRows?[]:[{date:data.month+'-01',day_type_he:'רגיל',start:'08:00',end:'08:00',end_day:1,start2:'18:00',end2:'22:00',site_name:'אילת',notes:'הערה נפרדת',reason:'סיבה ישנה',overtime_reason:'נשארתי באירוע',hours:22}]};
        const fetched=Date.now(),envelope={report:result,freshness:{source:window.__memoryDetail&&!options.forceFresh?'memory':'server',fetched_at_ms:fetched,expires_at_ms:fetched+30000}};
        if(window.__holdDetails)return new Promise(resolve=>window.__held.push({kind:'detail',uid:data.uid,resolve:()=>resolve(envelope)}));
        return envelope;
      },
      reviewEmployeeMonth:async data=>{
        const actor=__session.uid,copy=structuredClone(data);
        __calls.push({name:'review',data:copy});
        if(window.__reviewError)throw Object.assign(new Error('synthetic rejection'),{code:window.__reviewError});
        const id=Array.from(new Uint8Array(await digest('SHA-256',new TextEncoder().encode(JSON.stringify(['hr-review-event-v1',actor,data.request_id])))),b=>b.toString(16).padStart(2,'0')).join('');
        let saved=__reviews.find(r=>r.id===id),duplicate=!!saved;
        if(saved&&JSON.stringify(saved.data)!==JSON.stringify(copy))throw Object.assign(new Error('synthetic mismatched replay'),{code:'functions/already-exists'});
        if(!saved){saved={id,data:copy};__reviews.push(saved);const person=__people.find(p=>p.uid===data.uid);
          person.review_unavailable=false;person.review={review_id:id,reviewed_revision:data.expected_revision,actor_uid:actor,reviewed_at:{seconds:1788955200,nanoseconds:0},current:true};}
        if(window.__reviewLostReply){window.__reviewLostReply=false;throw Object.assign(new Error('synthetic lost receipt'),{code:'functions/deadline-exceeded'});}
        const result={review_id:id,reviewed_revision:data.expected_revision,current:true,duplicate,...window.__reviewPatch};
        if(window.__holdReviews)return new Promise(resolve=>__held.push({kind:'review',resolve:()=>resolve(result)}));
        return result;
      },
      requestNudge:async data=>{
        __calls.push({name:'request',data:structuredClone(data)});
        let saved=__registered.find(r=>r.data.request_id===data.request_id);
        if(!saved){const id=(++__requestCount).toString(16).padStart(64,'0');saved={data:structuredClone(data),result:__makeAction(data,id)};__registered.push(saved);}
        if(window.__timeoutAfterCommit){window.__timeoutAfterCommit=false;throw Object.assign(new Error('synthetic lost response'),{code:'functions/deadline-exceeded'});}
        if(window.__holdRequests)return new Promise(resolve=>__held.push({kind:'request',resolve:()=>resolve(structuredClone(saved.result))}));
        return structuredClone(saved.result);
      },
      listNudges:async data=>{
        __calls.push({name:'history',data});
        const all=(__historyRows||__registered.map(r=>({...r.result,recipient_uid:r.data.uid||null,updated_at_ms:r.result.created_at_ms,status_scope:'generation_only'}))).filter(a=>a.month===data.month&&a.station_id===__session.stationId).sort((a,b)=>a.action_id.localeCompare(b.action_id));
        const after=all.filter(a=>!data.cursor||a.action_id>data.cursor),items=after.slice(0,25);
        const result={month:data.month,items:structuredClone(items),next_cursor:after.length>25?items.at(-1).action_id:null};
        if(window.__holdHistory)return new Promise(resolve=>__held.push({kind:'history',resolve:()=>resolve(result)}));return result;
      },
      getNudgeStatus:async data=>{
        __calls.push({name:'status',data});
        if(window.__statusFailure)throw Object.assign(new Error('synthetic read failure'),{code:'functions/unavailable'});
        const saved=__registered.find(r=>r.result.action_id===data.action_id);
        const action=__historyRows?.find(a=>a.action_id===data.action_id)||(saved&&{...saved.result,recipient_uid:saved.data.uid||null,updated_at_ms:saved.result.created_at_ms,status_scope:'generation_only'});
        const after=__children.filter(c=>!data.cursor||c.id>data.cursor),items=after.slice(0,25);
        const result={action:structuredClone(action),items:structuredClone(items),next_cursor:after.length>25?items.at(-1).id:null,outcomes_scope:'this_page_only'};
        if(window.__holdStatus)return new Promise(resolve=>__held.push({kind:'status',resolve:()=>resolve(result)}));return result;
      }};
    window.__emit=()=>window.__listeners.forEach(cb=>cb());
    window.__release=()=>{const held=window.__held.splice(0);held.forEach(p=>p.resolve());};
  });
  const page=await context.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/hr.html');
  if(connected)await page.locator('.hr-person').first().waitFor();
  return {page,context,errors};
}
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
async function openReview(f,options={}) {
  await f.page.evaluate(options=>{Object.assign(__people[0],{snapshot_revision:'a'.repeat(64),revision_unavailable:false,...options});},options);
  await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="review-save"]').waitFor();
}
async function reviewCallCount(f){return f.page.evaluate(()=>__calls.filter(c=>c.name==='review').length);}
async function releaseKind(f,kind){await f.page.evaluate(kind=>{const selected=__held.filter(x=>x.kind===kind);__held=__held.filter(x=>x.kind!==kind);selected.forEach(x=>x.resolve());},kind);}
try {
  await check('public disconnected shell has no employee data or calls',async()=>{
    const f=await fixture({connected:false});assert.equal(await f.page.locator('.hr-person').count(),0);
    assert.equal(await f.page.locator('[data-hr="refresh"]').isDisabled(),true);
    assert.equal(await f.page.evaluate(()=>__calls.length),0);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('report shows stored/current totals, discrepancy and split segment',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();
    await f.page.getByRole('heading',{name:'עובד ראשון',exact:true}).waitFor();
    const t=await f.page.locator('[data-hr="detail"]').innerText();assert.ok(t.includes('24'));assert.ok(t.includes('22'));assert.ok(t.includes('שונה'));assert.ok(t.includes('18:00–22:00'));
    for(const value of ['הערה נפרדת','סיבה ישנה','נשארתי באירוע'])assert.ok(t.includes(value));
    assert.equal(await f.page.locator('tbody bdi').getAttribute('dir'),'ltr');
    assert.equal(await f.page.locator('tbody bdi').innerText(),'18:00–22:00');
    assert.deepEqual(f.errors,[]);await f.context.close();
  });
  for(const mode of ['legacy','absent','unavailable','current','changed','historical','inconsistent'])await check('inspection display '+mode,async()=>{
    const f=await fixture();
    await f.page.evaluate(mode=>{
      const p=__people.find(x=>x.uid==='u1');window.__memoryDetail=true;
      if(mode==='legacy')return;
      p.review_unavailable=mode==='unavailable';p.review=null;
      if(['absent','unavailable'].includes(mode))return;
      p.snapshot_revision='a'.repeat(64);p.revision_unavailable=false;
      p.review={review_id:'c'.repeat(64),actor_uid:'<img src=x onerror=alert(1)>',reviewed_at:{seconds:1788955200,nanoseconds:0},
        reviewed_revision:mode==='changed'||mode==='inconsistent'?'b'.repeat(64):'a'.repeat(64),
        current:mode==='historical'?null:mode!=='changed'};
    },mode);
    await f.page.locator('[data-uid="u1"]').click();await f.page.getByRole('heading',{name:'עובד ראשון',exact:true}).waitFor();
    const section=f.page.locator('[data-hr="detail"] [data-hr="inspection"]');
    const expected={legacy:'אינו זמין בגרסה זו',absent:'לא נרשם עיון',unavailable:'אינם זמינים לבדיקה',current:'תואם לתמונת הדוח שנטענה',changed:'הדוח השתנה מאז העיון',historical:'התאמה לגרסה הנוכחית לא אומתה',inconsistent:'אינם זמינים לבדיקה'};
    assert.ok((await section.innerText()).includes(expected[mode]));assert.equal(await section.locator('img').count(),0);
    assert.ok((await f.page.locator('[data-hr="detail"]').innerText()).includes('תמונת מצב מזיכרון הדף'));
    assert.equal(await f.page.evaluate(()=>__calls.filter(x=>x.name==='detail').length),1);
    await f.page.evaluate(()=>{__session=null;__emit();});assert.equal(await f.page.locator('[data-hr="detail"] [data-hr="inspection"]').count(),0);
    assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('left next and right previous use visible navigation',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.keyboard.press('ArrowLeft');
    await f.page.getByRole('heading',{name:'עובד שני',exact:true}).waitFor();await f.page.keyboard.press('ArrowRight');
    await f.page.getByRole('heading',{name:'עובד ראשון',exact:true}).waitFor();await f.context.close();
  });
  await check('arrows do not navigate while editing or using modifiers',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.getByRole('heading',{name:'עובד ראשון',exact:true}).waitFor();
    const count=await f.page.evaluate(()=>__calls.filter(c=>c.name==='detail').length);
    await f.page.locator('[data-hr="month"]').focus();await f.page.keyboard.press('ArrowLeft');await f.page.keyboard.press('Control+ArrowLeft');
    assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='detail').length),count);await f.context.close();
  });
  await check('historical report is labelled and contains no action buttons',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u3"]').click();await f.page.getByText('דוח היסטורי של עובד שאינו פעיל בתחנה.').waitFor();
    assert.equal(await f.page.locator('[data-hr="detail"] button').count(),0);await f.context.close();
  });
  await check('later selected report wins reversed detail completion order',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__holdDetails=true;});
    await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-uid="u2"]').click();
    await f.page.evaluate(()=>{__held.pop().resolve();});await f.page.getByRole('heading',{name:'עובד שני',exact:true}).waitFor();
    await f.page.evaluate(()=>{__held.pop().resolve();});assert.equal(await f.page.locator('[data-hr="detail"] h2').innerText(),'עובד שני');await f.context.close();
  });
  await check('late previous-month list cannot replace selected-month data',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__holdLists=true;__UI.refresh();});
    await f.page.evaluate(()=>{__people=[{uid:'new-month',full_name:'עובד בחודש החדש',state:'missing'}];});
    await f.page.locator('[data-hr="month"]').fill('2026-08');await f.page.locator('[data-hr="month"]').dispatchEvent('change');
    await f.page.evaluate(()=>{__held.pop().resolve();});await f.page.locator('[data-uid="new-month"]').waitFor();
    await f.page.evaluate(()=>{__release();});assert.equal(await f.page.evaluate(()=>__held.length),0);
    assert.equal(await f.page.locator('[data-uid="u1"]').count(),0);
    assert.equal(await f.page.locator('[data-hr="month"]').inputValue(),'2026-08');await f.context.close();
  });
  await check('identity change before observer clears held private response',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__holdDetails=true;});await f.page.locator('[data-uid="u1"]').click();
    await f.page.evaluate(()=>{__session=null;__release();});await f.page.getByText('נדרש חיבור עם הרשאת משאבי אנוש.').waitFor();
    assert.equal(await f.page.locator('.hr-person').count(),0);assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);await f.context.close();
  });
  await check('same uid role revocation synchronously removes displayed report',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="detail"] h2').waitFor();
    await f.page.evaluate(()=>{__session={...__session,role:'firefighter',epoch:2};__emit();});
    assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);assert.equal(await f.page.locator('.hr-person').count(),0);await f.context.close();
  });
  await check('unavailable identity clears existing private data without another request',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="detail"] h2').waitFor();
    const before=await f.page.evaluate(()=>__calls.length);
    await f.page.evaluate(()=>{__adapter.currentSession=()=>{throw new Error('identity unavailable');};__emit();});
    assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);assert.equal(await f.page.locator('.hr-person').count(),0);
    assert.equal(await f.page.evaluate(()=>__calls.length),before);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('same uid station change discards old list even before observer',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__holdLists=true;__UI.refresh();});
    await f.page.evaluate(()=>{__session={...__session,stationId:'another_station',epoch:2};__people=[];__holdLists=false;__release();});
    await f.page.getByText('אין עובדים להצגה בחודש הזה.').waitFor();assert.equal(await f.page.locator('.hr-person').count(),0);await f.context.close();
  });
  await check('saved old row callback cannot fetch after identity change',async()=>{
    const f=await fixture();const before=await f.page.evaluate(()=>__calls.length);
    await f.page.evaluate(()=>{const b=document.querySelector('[data-uid="u1"]');__session=null;b.click();});
    assert.equal(await f.page.evaluate(()=>__calls.length),before);assert.equal(await f.page.locator('.hr-person').count(),0);await f.context.close();
  });
  await check('empty continuation page preserves ability to advance',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__people=[];__cursor='next-page';__UI.refresh();});
    await f.page.locator('[data-hr="more"]').waitFor({state:'visible'});
    await f.page.evaluate(()=>{__people=[{uid:'next',full_name:'עובד נוסף',state:'missing'}];__cursor=null;});
    await f.page.locator('[data-hr="more"]').click();await f.page.locator('[data-uid="next"]').waitFor();await f.context.close();
  });
  await check('list failure clears existing private detail',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="detail"] h2').waitFor();
    await f.page.evaluate(()=>{__adapter.listMonth=async()=>{throw new Error('fixture failure');};__UI.refresh();});
    await f.page.getByText('טעינת הדוחות נכשלה. לחצו רענון כדי לנסות שוב.').waitFor();assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);await f.context.close();
  });
  await check('names are rendered as text and not executable markup',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__people=[{uid:'xss',full_name:'<img src=x onerror=alert(1)>',state:'missing'}];__UI.refresh();});
    await f.page.locator('[data-uid="xss"]').waitFor();assert.equal(await f.page.locator('#hr-workspace img').count(),0);assert.ok((await f.page.locator('[data-uid="xss"]').innerText()).includes('<img'));await f.context.close();
  });
  await check('initial own-month history is bounded once and empty eligible report has a nudge',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__emptyRows=true;__people[0].state='missing';});
    await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="nudge-person"]').waitFor();
    assert.ok((await f.page.locator('[data-hr="detail"]').innerText()).includes('אין רשומות'));
    assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='history').length),1);
    await f.page.locator('[data-hr="nudge-person"]').click();await f.page.waitForFunction(()=>__registered.length===1&&document.querySelector('[data-hr="nudge-message"]').textContent.includes('נרשמה'));
    const data=await f.page.evaluate(()=>__registered[0].data);assert.equal(data.uid,'u1');assert.equal(data.send_now,false);assert.deepEqual(Object.keys(data).sort(),['month','request_id','send_now','uid']);
    assert.equal(await f.page.locator('[data-hr="pending"]').isHidden(),true);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('memory snapshot has no personal mutation; fresh check is explicit and never sends automatically',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="nudge-person"]').waitFor();
    await f.page.evaluate(()=>{__savedNudge=document.querySelector('[data-hr="nudge-person"]');__memoryDetail=true;});
    await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="detail-fresh"]').waitFor();
    const text=await f.page.locator('[data-hr="detail"]').innerText();assert.ok(text.includes('תמונת מצב מזיכרון הדף בלבד'));assert.ok(text.includes('זמן קריאה'));assert.ok(text.includes('ייתכן שהנתונים השתנו'));
    assert.equal(await f.page.locator('[data-hr="nudge-person"]').count(),0);
    await f.page.evaluate(()=>__savedNudge.click());assert.equal(await f.page.evaluate(()=>__registered.length),0);
    await f.page.locator('[data-hr="detail-fresh"]').click();await f.page.locator('[data-hr="nudge-person"]').waitFor();
    assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='detail').at(-1).options.forceFresh),true);
    assert.equal(await f.page.evaluate(()=>__registered.length),0);await f.page.locator('[data-hr="nudge-person"]').click();
    await f.page.waitForFunction(()=>__registered.length===1);assert.equal(await f.page.evaluate(()=>__registered[0].data.uid),'u1');await f.context.close();
  });
  await check('fresh response that is no longer outstanding removes cached nudge eligibility',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__memoryDetail=true;});await f.page.locator('[data-uid="u1"]').click();
    await f.page.locator('[data-hr="detail-fresh"]').waitFor();await f.page.evaluate(()=>{__people[0].state='approved';__people[0].reminder_eligible=false;});
    await f.page.locator('[data-hr="detail-fresh"]').click();await f.page.locator('[data-hr="detail"] .hr-tag').getByText('מאושר',{exact:true}).waitFor();
    assert.equal(await f.page.locator('[data-hr="nudge-person"]').count(),0);assert.equal(await f.page.evaluate(()=>__registered.length),0);await f.context.close();
  });
  await check('malformed freshness or forceFresh returning memory fails closed without private fallback',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__memoryDetail=true;});await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="detail-fresh"]').waitFor();
    await f.page.evaluate(()=>{const original=__adapter.getEmployeeMonth;__adapter.getEmployeeMonth=async(data,options)=>{const value=await original(data,options);value.freshness.source='memory';return value;};});
    await f.page.locator('[data-hr="detail-fresh"]').click();await f.page.getByText('לא ניתן לטעון את הדוח כרגע. רעננו או עברו לדוח הבא.').waitFor();
    assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);assert.equal(await f.page.locator('[data-hr="nudge-person"]').count(),0);
    await f.page.evaluate(()=>{const original=__adapter.getEmployeeMonth;__adapter.getEmployeeMonth=async(data,options)=>{const value=await original(data,options);value.freshness.expires_at_ms=value.freshness.fetched_at_ms;return value;};});
    await f.page.locator('[data-uid="u1"]').click();await f.page.getByText('לא ניתן לטעון את הדוח כרגע. רעננו או עברו לדוח הבא.').waitFor();
    assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);assert.equal(await f.page.evaluate(()=>__registered.length),0);await f.context.close();
  });
  await check('UI refresh month identity and destruction explicitly invalidate adapter detail memory',async()=>{
    const f=await fixture();const initial=await f.page.evaluate(()=>__cacheClears);
    await f.page.locator('[data-hr="refresh"]').click();assert.equal(await f.page.evaluate(()=>__cacheClears),initial+1);
    await f.page.locator('[data-hr="month"]').fill('2025-08');assert.equal(await f.page.evaluate(()=>__cacheClears),initial+2);
    await f.page.evaluate(()=>{__session={...__session,epoch:2};__emit();});assert.equal(await f.page.evaluate(()=>__cacheClears),initial+3);
    await f.page.evaluate(()=>__UI.destroy());assert.equal(await f.page.evaluate(()=>__cacheClears),initial+4);
    assert.equal(await f.page.locator('.hr-person').count(),0);assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);await f.context.close();
  });
  await check('ineligible states and historical reports never gain personal actions from a true summary flag',async()=>{
    const f=await fixture();
    for(const [state,historical] of [['submitted',false],['approved',false],['unavailable',false],['draft',true]]){
      await f.page.evaluate(([state,historical])=>{__people[0]={...__people[0],state,historical,reminder_eligible:true};__UI.refresh();},[state,historical]);
      await f.page.locator('[data-uid="u1"]').waitFor();await f.page.locator('[data-uid="u1"]').click();
      await f.page.waitForFunction(()=>!document.querySelector('[data-hr="detail"]').textContent.includes('טוען'));
      assert.equal(await f.page.locator('[data-hr="nudge-person"]').count(),0);
    }
    await f.context.close();
  });
  await check('bulk sends one server audience request without visible UIDs or visible eligibility dependence',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__people=[{uid:'shown',full_name:'דוח מאושר',state:'approved',historical:false,reminder_eligible:false}];__cursor='unseen-page';__UI.refresh();});
    await f.page.locator('[data-uid="shown"]').waitFor();await f.page.locator('[data-hr="nudge-station"]').click();
    await f.page.waitForFunction(()=>__registered.length===1);const data=await f.page.evaluate(()=>__registered[0].data);
    assert.deepEqual(Object.keys(data).sort(),['month','request_id','send_now']);assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='request').length),1);
    assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='detail').length),0);await f.context.close();
  });
  await check('lost response after commit retains identical retry and locks navigation in handlers',async()=>{
    const f=await fixture();await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="nudge-person"]').waitFor();
    await f.page.evaluate(()=>{__timeoutAfterCommit=true;});await f.page.locator('[data-hr="nudge-person"]').click();await f.page.locator('[data-hr="pending"]').waitFor({state:'visible'});
    for(const key of ['month','refresh','next','previous','nudge-station','send-now','history-refresh'])assert.equal(await f.page.locator('[data-hr="'+key+'"]').isDisabled(),true);
    const before=await f.page.evaluate(()=>__calls.length),month=await f.page.locator('[data-hr="month"]').inputValue();
    await f.page.evaluate(()=>{__UI.refresh();document.querySelector('[data-uid="u2"]').dispatchEvent(new MouseEvent('click'));const m=document.querySelector('[data-hr="month"]');m.value='2025-01';m.dispatchEvent(new Event('change'));});
    await f.page.keyboard.press('ArrowLeft');assert.equal(await f.page.evaluate(()=>__calls.length),before);assert.equal(await f.page.locator('[data-hr="month"]').inputValue(),month);
    assert.equal(await f.page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}),true);
    await f.page.locator('[data-hr="retry"]').click();await f.page.waitForFunction(()=>document.querySelector('[data-hr="nudge-message"]').textContent.includes('נרשמה'));
    const values=await f.page.evaluate(()=>({requests:__calls.filter(c=>c.name==='request').map(c=>c.data),records:__registered.length}));
    assert.equal(values.records,1);assert.deepEqual(values.requests[0],values.requests[1]);assert.equal(await f.page.locator('[data-hr="pending"]').isHidden(),true);await f.context.close();
  });
  await check('quiet confirmation uses new ID and original target after another report selection',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__quiet=true;});await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="nudge-person"]').click();
    await f.page.locator('[data-hr="confirmation"]').waitFor({state:'visible'});assert.equal(await f.page.evaluate(()=>__registered.length),1);
    await f.page.locator('[data-uid="u2"]').click();await f.page.getByRole('heading',{name:'עובד שני',exact:true}).waitFor();
    await f.page.locator('[data-hr="confirm"]').click();await f.page.waitForFunction(()=>__registered.length===2);
    const values=await f.page.evaluate(()=>__registered.map(r=>r.data));assert.notEqual(values[0].request_id,values[1].request_id);
    assert.equal(values[1].uid,'u1');assert.equal(values[1].month,values[0].month);assert.equal(values[1].send_now,true);assert.equal(values[0].send_now,false);
    assert.equal(await f.page.locator('[data-hr="send-now"]').isChecked(),false);await f.context.close();
  });
  await check('validated producer DTO stays registered when follow-up status read fails',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__statusFailure=true;});await f.page.locator('[data-hr="nudge-station"]').click();
    await f.page.getByText('מצב הבקשה אינו זמין כרגע. בקשה שכבר נרשמה נשארת רשומה; רעננו את המצב בלבד.').waitFor();
    assert.ok((await f.page.locator('[data-hr="nudge-message"]').innerText()).includes('נרשמה'));assert.equal(await f.page.locator('[data-hr="pending"]').isHidden(),true);
    assert.equal(await f.page.locator('[data-hr="month"]').isDisabled(),false);await f.page.locator('[data-hr="status-refresh"]').click();
    assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='request').length),1);await f.context.close();
  });
  await check('malformed producer response is unknown while definite quota failure unlocks controls',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__adapter.requestNudge=async()=>({action_id:'a'.repeat(64)});});await f.page.locator('[data-hr="nudge-station"]').click();
    await f.page.locator('[data-hr="pending"]').waitFor({state:'visible'});
    await f.page.evaluate(()=>{__adapter.requestNudge=async()=>{throw Object.assign(new Error('quota'),{code:'functions/resource-exhausted'});};});await f.page.locator('[data-hr="retry"]').click();
    await f.page.getByText('בוצעו פעולות רבות. המתינו לפני בקשה חדשה.').waitFor();assert.equal(await f.page.locator('[data-hr="pending"]').isHidden(),true);
    assert.equal(await f.page.locator('[data-hr="month"]').isDisabled(),false);await f.context.close();
  });
  await check('action and child cursors paginate manually; provider and unknown labels never promise delivery',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{const month=document.querySelector('[data-hr="month"]').value;
      __historyRows=Array.from({length:27},(_,i)=>__rich({month,send_now:false},(i+1).toString(16).padStart(64,'0')));
      __children=Array.from({length:27},(_,i)=>__makeChild((i+1).toString(16).padStart(64,'0'),i===0?'u1':'unloaded-'+i,i===0?'accepted':i===1?'outcome_unknown':'queued',i===0?{accepted:1,failed:0,outcome_unknown:0}:null));});
    await f.page.locator('[data-hr="history-refresh"]').click();await f.page.waitForFunction(()=>document.querySelectorAll('[data-action]').length===25);
    assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='history').length),2);await f.page.locator('[data-hr="actions-more"]').click();await f.page.waitForFunction(()=>document.querySelectorAll('[data-action]').length===27);
    await f.page.locator('[data-action]').first().click();await f.page.waitForFunction(()=>document.querySelectorAll('.hr-outcome').length===25);
    assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='status').length),1);
    const text=await f.page.locator('[data-hr="action-detail"]').innerText();assert.ok(text.includes('הספק קיבל — לא אישור מסירה'));assert.ok(text.includes('תוצאת הניסיון אינה ידועה'));assert.ok(text.includes('תוצאת ספק אינה זמינה'));assert.ok(text.includes('שם לא זמין'));assert.ok(!text.includes('unloaded-'));
    await f.page.locator('[data-hr="children-more"]').click();await f.page.waitForFunction(()=>document.querySelectorAll('.hr-outcome').length===27);
    const calls=await f.page.evaluate(()=>__calls);assert.ok(calls.find(c=>c.name==='history'&&c.data.cursor));assert.ok(calls.find(c=>c.name==='status'&&c.data.cursor));
    await f.page.locator('[data-hr="status-refresh"]').click();await f.page.waitForFunction(()=>document.querySelectorAll('.hr-outcome').length===25);
    assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='status').at(-1).data.cursor),undefined);
    assert.deepEqual(await f.page.evaluate(()=>[localStorage.length,sessionStorage.length,location.search]),[0,0,'']);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('late prior-month history and prior-action status cannot replace newer snapshots',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{const month=document.querySelector('[data-hr="month"]').value;__historyRows=[__rich({month},'1'.repeat(64)),{...__rich({month},'2'.repeat(64)),status:'completed'}];});
    await f.page.locator('[data-hr="history-refresh"]').click();await f.page.locator('[data-action]').first().waitFor();await f.page.evaluate(()=>{__holdStatus=true;});
    await f.page.locator('[data-action]').first().click();await f.page.locator('[data-action]').nth(1).click();await f.page.evaluate(()=>__held.pop().resolve());
    await f.page.locator('.hr-action-summary').getByText('הכנת התזכורות הסתיימה',{exact:true}).waitFor();const before=await f.page.locator('[data-hr="action-detail"]').innerText();assert.ok(before.includes('הכנת התזכורות הסתיימה'));assert.ok(!before.includes('איתור נמענים'));await f.page.evaluate(()=>__held.pop().resolve());assert.equal(await f.page.locator('[data-hr="action-detail"]').innerText(),before);
    await f.page.evaluate(()=>{__holdHistory=true;__UI.refresh();});await f.page.locator('[data-hr="month"]').fill('2025-02');await f.page.locator('[data-hr="month"]').dispatchEvent('change');
    await f.page.evaluate(()=>__held.pop().resolve());await f.page.getByText('אין בקשות שלי להצגה בחודש הזה.').waitFor();await f.page.evaluate(()=>__release());
    assert.equal(await f.page.locator('[data-action]').count(),0);assert.equal(await f.page.locator('.hr-action-summary').count(),0);await f.context.close();
  });
  await check('identity reset clears pending and stale mutation cannot revive it',async()=>{
    const f=await fixture();await f.page.evaluate(()=>{__holdRequests=true;});await f.page.locator('[data-hr="nudge-station"]').click();
    await f.page.waitForFunction(()=>__held.some(h=>h.kind==='request'));await f.page.evaluate(()=>{__session={...__session,uid:'other-actor',stationId:'other-station',epoch:2};__emit();__release();});
    assert.equal(await f.page.locator('[data-hr="pending"]').isHidden(),true);assert.equal(await f.page.locator('[data-hr="nudge-message"]').innerText(),'');
    assert.equal(await f.page.locator('[data-action]').count(),0);assert.equal(await f.page.locator('[data-hr="month"]').isDisabled(),false);await f.context.close();
  });
  await check('review save requires an eligible canonical server detail and never runs on a fresh read',async()=>{
    const f=await fixture();
    for(const fields of [{},{snapshot_revision:'invalid',revision_unavailable:false},{snapshot_revision:'a'.repeat(64),revision_unavailable:true},{snapshot_revision:'a'.repeat(64),revision_unavailable:false,state:'missing'}]){
      await f.page.evaluate(fields=>{delete __people[0].snapshot_revision;delete __people[0].revision_unavailable;Object.assign(__people[0],{state:'draft'},fields);},fields);
      await f.page.locator('[data-uid="u1"]').click();await f.page.locator('tbody tr').waitFor();assert.equal(await f.page.locator('[data-hr="review-save"]').count(),0);
    }
    for(const state of ['draft','submitted','approved']){await openReview(f,{state,historical:true});assert.equal(await f.page.locator('[data-hr="review-save"]').isEnabled(),true);}
    await f.page.evaluate(()=>{__memoryDetail=true;});await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="detail-fresh"]').waitFor();
    assert.equal(await f.page.locator('[data-hr="review-save"]').count(),0);await f.page.locator('[data-hr="detail-fresh"]').click();await f.page.locator('[data-hr="review-save"]').waitFor();
    assert.equal(await reviewCallCount(f),0);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('review locks synchronously before digest and keeps handlers locked through receipt and refresh',async()=>{
    const f=await fixture();await openReview(f);const month=await f.page.locator('[data-hr="month"]').inputValue();
    await f.page.evaluate(()=>{crypto.subtle.digest=(...args)=>new Promise(resolve=>{window.__finishDigest=async()=>resolve(await __nativeDigest(...args));});__holdReviews=true;});
    await f.page.locator('[data-hr="review-save"]').click();await f.page.waitForFunction(()=>typeof __finishDigest==='function');
    assert.equal(await reviewCallCount(f),0);assert.equal(await f.page.locator('[data-hr="month"]').isDisabled(),true);
    await f.page.evaluate(()=>{for(const name of ['next','nudge-station','review-save'])document.querySelector('[data-hr="'+name+'"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.querySelector('[data-uid="u2"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));const m=document.querySelector('[data-hr="month"]');m.value='2024-01';m.dispatchEvent(new Event('change'));});
    assert.equal(await f.page.locator('[data-hr="month"]').inputValue(),month);assert.equal(await f.page.locator('[data-hr="detail"] h2').innerText(),'עובד ראשון');
    assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='request').length),0);
    await f.page.evaluate(()=>__finishDigest());await f.page.waitForFunction(()=>__held.some(x=>x.kind==='review'));
    const data=await f.page.evaluate(()=>__calls.find(c=>c.name==='review').data);assert.deepEqual(Object.keys(data).sort(),['expected_revision','month','request_id','uid']);assert.equal(data.uid,'u1');assert.equal(data.month,month);assert.equal(data.expected_revision,'a'.repeat(64));assert.match(data.request_id,/^[0-9a-f-]{36}$/);
    await f.page.evaluate(()=>{__holdDetails=true;});await releaseKind(f,'review');await f.page.waitForFunction(()=>__held.some(x=>x.kind==='detail'));
    assert.equal(await f.page.locator('[data-hr="review-retry"]').isHidden(),true);assert.equal(await f.page.locator('[data-hr="month"]').isDisabled(),true);
    await f.page.evaluate(()=>{const m=document.querySelector('[data-hr="month"]');m.value='2023-01';m.dispatchEvent(new Event('change'));});assert.equal(await f.page.locator('[data-hr="month"]').inputValue(),month);
    await releaseKind(f,'detail');await f.page.waitForFunction(()=>!document.querySelector('[data-hr="month"]').disabled);
    assert.ok((await f.page.locator('[data-hr="detail"] [data-hr="inspection"]').innerText()).includes('תואם לתמונת הדוח'));
    assert.equal(await reviewCallCount(f),1);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('local digest rejection sends nothing and permits an explicit fresh selection',async()=>{
    const f=await fixture();await openReview(f);await f.page.evaluate(()=>{crypto.subtle.digest=async()=>{throw new Error('synthetic digest failure');};});await f.page.locator('[data-hr="review-save"]').click();
    await f.page.getByText('לא ניתן להכין שמירת עיון מאובטחת. לא נשלחה בקשה.').waitFor();assert.equal(await reviewCallCount(f),0);assert.equal(await f.page.locator('[data-hr="review-retry"]').isHidden(),true);assert.equal(await f.page.locator('[data-hr="month"]').isDisabled(),false);
    await f.page.evaluate(()=>{crypto.subtle.digest=__nativeDigest;});await f.page.locator('[data-uid="u1"]').click();await f.page.locator('[data-hr="review-save"]').waitFor();await f.page.locator('[data-hr="review-save"]').click();
    await f.page.waitForFunction(()=>__reviews.length===1&&!document.querySelector('[data-hr="month"]').disabled);assert.equal(await reviewCallCount(f),1);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('identity change during digest discards intent before any transport',async()=>{
    const f=await fixture();await openReview(f);await f.page.evaluate(()=>{crypto.subtle.digest=(...args)=>new Promise(resolve=>{window.__finishDigest=async()=>resolve(await __nativeDigest(...args));});});await f.page.locator('[data-hr="review-save"]').click();
    await f.page.waitForFunction(()=>typeof __finishDigest==='function');await f.page.evaluate(async()=>{__session=null;__emit();await __finishDigest();});
    assert.equal(await reviewCallCount(f),0);assert.equal(await f.page.locator('.hr-person').count(),0);assert.equal(await f.page.locator('[data-hr="review-message"]').innerText(),'');assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('lost receipt retries the identical intent even after a later quota rejection',async()=>{
    const f=await fixture();await openReview(f);await f.page.evaluate(()=>{__reviewLostReply=true;});await f.page.locator('[data-hr="review-save"]').click();await f.page.locator('[data-hr="review-retry"]').waitFor({state:'visible'});
    assert.equal(await f.page.evaluate(()=>__reviews.length),1);await f.page.evaluate(()=>{__reviewError='functions/resource-exhausted';});await f.page.locator('[data-hr="review-retry"]').click();await f.page.locator('[data-hr="review-retry"]').waitFor({state:'visible'});
    assert.equal(await f.page.locator('[data-hr="month"]').isDisabled(),true);assert.ok((await f.page.locator('[data-hr="review-message"]').innerText()).includes('לא ניתן לקבוע'));
    await f.page.evaluate(()=>{__reviewError=null;});await f.page.locator('[data-hr="review-retry"]').click();await f.page.waitForFunction(()=>__calls.filter(c=>c.name==='review').length===3&&!document.querySelector('[data-hr="month"]').disabled);
    const calls=await f.page.evaluate(()=>__calls.filter(c=>c.name==='review'));assert.deepEqual(calls[0].data,calls[1].data);assert.deepEqual(calls[0].data,calls[2].data);assert.equal(await f.page.evaluate(()=>__reviews.length),1);
    assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='detail'&&c.options.forceFresh).length),1);assert.equal(await f.page.locator('[data-hr="review-retry"]').isHidden(),true);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  for(const patch of [{review_id:'f'.repeat(64)},{reviewed_revision:'b'.repeat(64)},{extra:true},{duplicate:'false'},{current:false},{current:null}])await check('invalid review receipt stays uncertain '+JSON.stringify(patch),async()=>{
    const f=await fixture();await openReview(f);await f.page.evaluate(patch=>{__reviewPatch=patch;},patch);await f.page.locator('[data-hr="review-save"]').click();await f.page.locator('[data-hr="review-retry"]').waitFor({state:'visible'});
    assert.equal(await f.page.locator('[data-hr="month"]').isDisabled(),true);assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='detail'&&c.options.forceFresh).length),0);
    await f.page.evaluate(()=>{__reviewPatch=null;});await f.page.locator('[data-hr="review-retry"]').click();await f.page.waitForFunction(()=>__calls.filter(c=>c.name==='review').length===2&&!document.querySelector('[data-hr="month"]').disabled);
    assert.equal(await f.page.evaluate(()=>__reviews.length),1);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  for(const current of [false,null])await check('validated duplicate review accepts historical current '+current,async()=>{
    const f=await fixture();await openReview(f);await f.page.evaluate(()=>{__reviewLostReply=true;});await f.page.locator('[data-hr="review-save"]').click();await f.page.locator('[data-hr="review-retry"]').waitFor({state:'visible'});
    await f.page.evaluate(current=>{__reviewPatch={current};},current);await f.page.locator('[data-hr="review-retry"]').click();await f.page.waitForFunction(()=>__calls.filter(c=>c.name==='review').length===2&&!document.querySelector('[data-hr="month"]').disabled);
    assert.ok((await f.page.locator('[data-hr="review-message"]').innerText()).includes('העיון נרשם'));assert.equal(await f.page.evaluate(()=>__reviews.length),1);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  for(const code of ['aborted','resource-exhausted'])await check('first definite review '+code+' requires reread without automatic rebase',async()=>{
    const f=await fixture();await openReview(f);await f.page.evaluate(code=>{__reviewError='functions/'+code;},code);await f.page.locator('[data-hr="review-save"]').click();await f.page.waitForFunction(()=>__calls.some(c=>c.name==='review')&&!document.querySelector('[data-hr="month"]').disabled);
    assert.equal(await f.page.locator('[data-hr="review-save"]').count(),0);assert.equal(await f.page.locator('[data-hr="review-retry"]').isHidden(),true);assert.equal(await f.page.evaluate(()=>__reviews.length),0);assert.equal(await reviewCallCount(f),1);assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='detail').length),1);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('known review success survives failed refresh without duplicate write or stale save control',async()=>{
    const f=await fixture();await openReview(f);await f.page.evaluate(()=>{__failReviewRefresh=true;});await f.page.locator('[data-hr="review-save"]').click();await f.page.waitForFunction(()=>document.querySelector('[data-hr="review-message"]').textContent.includes('הרענון נכשל'));
    assert.ok((await f.page.locator('[data-hr="review-message"]').innerText()).includes('שמירת העיון אינה מתבטלת'));assert.equal(await f.page.locator('[data-hr="review-save"]').count(),0);assert.equal(await f.page.locator('[data-hr="review-retry"]').isHidden(),true);assert.equal(await f.page.locator('[data-hr="month"]').isDisabled(),false);
    await f.page.locator('[data-hr="review-retry"]').dispatchEvent('click');assert.equal(await reviewCallCount(f),1);await f.page.locator('[data-uid="u2"]').click();await f.page.getByRole('heading',{name:'עובד שני',exact:true}).waitFor();assert.deepEqual(f.errors,[]);await f.context.close();
  });
  for(const mode of ['observer','unobserved-same-key'])await check('held review result is fenced after identity '+mode,async()=>{
    const f=await fixture();await openReview(f);await f.page.evaluate(()=>{__holdReviews=true;});await f.page.locator('[data-hr="review-save"]').click();await f.page.waitForFunction(()=>__held.some(x=>x.kind==='review'));
    await f.page.evaluate(mode=>{__session=mode==='observer'?null:{...__session};if(mode==='observer')__emit();},mode);await releaseKind(f,'review');
    await f.page.waitForFunction(()=>document.querySelector('[data-hr="review-message"]').textContent==='');assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);assert.equal(await f.page.evaluate(()=>__calls.filter(c=>c.name==='detail'&&c.options.forceFresh).length),0);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('pagehide clears private review state and resumes reads without replay only on pageshow',async()=>{
    const f=await fixture();await openReview(f);await f.page.evaluate(()=>{__holdReviews=true;});await f.page.locator('[data-hr="review-save"]').click();await f.page.waitForFunction(()=>__held.some(x=>x.kind==='review'));
    const before=await f.page.evaluate(()=>__calls.length);await f.page.evaluate(()=>{dispatchEvent(new Event('pagehide'));__emit();__UI.refresh();});
    assert.equal(await f.page.locator('.hr-person').count(),0);assert.equal(await f.page.locator('[data-hr="review-message"]').innerText(),'');assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);await releaseKind(f,'review');assert.equal(await f.page.evaluate(()=>__calls.length),before);
    await f.page.evaluate(()=>dispatchEvent(new Event('pageshow')));await f.page.locator('.hr-person').first().waitFor();assert.equal(await reviewCallCount(f),1);assert.equal(await f.page.locator('[data-hr="review-retry"]').isHidden(),true);assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('held post-save fresh detail cannot paint after identity reset',async()=>{
    const f=await fixture();await openReview(f);await f.page.evaluate(()=>{__holdDetails=true;});await f.page.locator('[data-hr="review-save"]').click();await f.page.waitForFunction(()=>__held.some(x=>x.kind==='detail'));
    await f.page.evaluate(()=>{__session=null;__emit();});await releaseKind(f,'detail');assert.equal(await f.page.locator('[data-hr="detail"] h2').count(),0);assert.equal(await f.page.locator('[data-hr="review-message"]').innerText(),'');assert.equal(await f.page.locator('[data-hr="review-retry"]').isHidden(),true);assert.deepEqual(f.errors,[]);await f.context.close();
  });
  await check('prior selected detail cannot replace frozen review and a loading list cannot initiate review',async()=>{
    const f=await fixture();await openReview(f);await f.page.evaluate(()=>{__holdDetails=true;});await f.page.locator('[data-uid="u2"]').click();await f.page.locator('[data-uid="u1"]').click();await f.page.evaluate(()=>{const h=__held.find(x=>x.kind==='detail'&&x.uid==='u1');__held=__held.filter(x=>x!==h);h.resolve();});await f.page.locator('[data-hr="review-save"]').waitFor();
    await f.page.evaluate(()=>{__holdReviews=true;});await f.page.locator('[data-hr="review-save"]').click();await f.page.waitForFunction(()=>__held.some(x=>x.kind==='review'));await releaseKind(f,'detail');assert.equal(await f.page.locator('[data-hr="detail"] h2').innerText(),'עובד ראשון');assert.equal(await reviewCallCount(f),1);assert.deepEqual(f.errors,[]);await f.context.close();
    const g=await fixture();await g.page.evaluate(()=>{__cursor='next';__UI.refresh();});await g.page.locator('[data-hr="more"]').waitFor({state:'visible'});await openReview(g);await g.page.evaluate(()=>{__holdLists=true;});await g.page.locator('[data-hr="more"]').click();await g.page.waitForFunction(()=>__held.some(x=>x.kind==='list'));await g.page.locator('[data-hr="review-save"]').dispatchEvent('click');assert.equal(await reviewCallCount(g),0);assert.deepEqual(g.errors,[]);await g.context.close();
  });
  for(const width of [320,390,1100])for(const theme of ['light','dark'])await check('readable layout '+width+' '+theme,async()=>{
    const f=await fixture({width,theme});await f.page.locator('[data-uid="u1"]').click();await f.page.locator('tbody tr').waitFor();
    assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(f.errors,[]);
    if(width===1100&&theme==='light'&&process.env.HR_SCREENSHOT)await f.page.screenshot({path:process.env.HR_SCREENSHOT,fullPage:true});
    await f.context.close();
  });
  console.log(passed+' HR browser scenarios passed. No production calls.');
}finally{await browser.close();}
