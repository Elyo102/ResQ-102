// Actual markup and actual onboarding handlers; Firebase and callable boundaries are mocked.
// No deployed endpoint, authentication service, mail, clipboard or provider is contacted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const between=(text,start,end)=>{const a=text.indexOf(start),b=text.indexOf(end,a);assert(a>=0&&b>a,`source anchors ${start}`);return text.slice(a,b);};
const browser=await chromium.launch({headless:true});
let passed=0;
function check(name,value){assert(value,name);passed++;console.log('PASS '+name);}
async function screenshot(page,name,card){
  if(!process.env.ONBOARDING_UI_SCREENSHOT_DIR)return;
  const dir=path.resolve(process.env.ONBOARDING_UI_SCREENSHOT_DIR);fs.mkdirSync(dir,{recursive:true});
  await page.evaluate(id=>{const badge=document.createElement('p');badge.textContent='נתוני בדיקה בלבד — שירותים מדומים';document.getElementById(id).prepend(badge);},card);
  await page.evaluate(()=>document.getAnimations().forEach(animation=>{try{animation.finish();}catch{}}));
  await page.waitForFunction(id=>{let el=document.getElementById(id);while(el){if(Number(getComputedStyle(el).opacity)<0.99)return false;el=el.parentElement;}return true;},card,{timeout:5000});
  await page.locator('#'+card).screenshot({path:path.join(dir,name+'-390-mock.png')});
}
async function pageFor(name){
  const html=fs.readFileSync(path.join(root,name),'utf8');
  const page=await browser.newPage({viewport:{width:390,height:844}});
  page.setDefaultTimeout(5000);
  await page.route('**/*',route=>route.abort());
  const localHtml=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,tag=>{
    const href=tag.match(/href=["']([^"']+)["']/i)?.[1]||'';
    if(!/\.css(?:\?|$)/i.test(href)||/^(?:https?:|\/\/)/i.test(href))return '';
    const file=path.resolve(root,href.split('?')[0]);
    return file.startsWith(root+path.sep)&&fs.existsSync(file)?'<style>'+fs.readFileSync(file,'utf8')+'</style>':'';
  });
  await page.setContent(localHtml);
  // The stripped login bootstrap normally sets ready after its background loads.
  // Reproduce that documented settled state without fetching external resources.
  if(name==='login.html')await page.evaluate(()=>document.body.classList.add('art','ready'));
  await page.evaluate(()=>{document.querySelectorAll('.hide').forEach(el=>el.classList.remove('hide'));document.body.style.opacity='1';document.body.style.animation='none';});
  return {page,html};
}
try{
  const {page,html}=await pageFor('admin.html');
  const code=between(html,'let stationUiEpoch','initPWA({ offer: false });');
  await page.addScriptTag({content:`
    const $=id=>document.getElementById(id);
    const DISTRICTS=[{id:'south',name:'דרום'}];let serial=0;
    const newOperationId=prefix=>prefix+'test_request_'+(++serial);
    function msg(el,text,kind){const m=$(el);m.textContent=text;m.className='msg '+kind;}
    window.calls=[];window.nextError=false;window.delay=null;
    const auth={currentUser:{uid:'super1',getIdTokenResult:async()=>({claims:{super:true}})}};
    const stationUiCalls=Object.fromEntries(['create','issue','ready'].map(kind=>[kind,async payload=>{
      calls.push({kind,payload:JSON.parse(JSON.stringify(payload))});
      if(window.delay)await window.delay;
      if(window.nextError){window.nextError=false;throw new Error('connection lost');}
      return {data:kind==='issue'?{ok:true,secret_available:true,invite_id:'invite_test',secret:'secret_mock_only'}:{ok:true}};
    }]));
    ${code}
    window.switchActor=uid=>{auth.currentUser=uid?{uid,getIdTokenResult:async()=>({claims:{super:true}})}:null;resetStationUi();};
  `});
  await page.locator('#spId').fill('test_station');await page.locator('#spName').fill('תחנת בדיקה');await page.locator('#spDistrict').selectOption('south');
  await page.evaluate(()=>window.nextError=true);await page.locator('#spCreate').click();
  await page.waitForFunction(()=>document.getElementById('spStatus').textContent.includes('connection lost'));
  await page.locator('#spCreate').click();await page.waitForFunction(()=>document.getElementById('spStatus').textContent.includes('התחנה נוצרה'));
  check('admin create retry retains full intent',await page.evaluate(()=>JSON.stringify(calls[0].payload)===JSON.stringify(calls[1].payload)));
  check('admin actual message helper reports created, not active',await page.locator('#spStatus').textContent().then(s=>s.includes('עדיין אינה פעילה')));
  await page.locator('#spFirstName').fill('מפקד בדיקה');await page.locator('#spEmail').fill('test@example.invalid');await page.locator('#spPhone').fill('0500000000');await page.locator('#spShift').selectOption('A');
  await page.locator('#spIssue').click();await page.waitForFunction(()=>document.getElementById('spSecret').value==='secret_mock_only');
  check('issue bound to created station request without role override',await page.evaluate(()=>{const p=calls.at(-1).payload;return p.provision_request_id===calls[0].payload.request_id&&p.station_id==='test_station'&&!('role'in p);}));
  await screenshot(page,'admin-onboarding','stationProvisionCard');
  await page.evaluate(()=>switchActor('super2'));
  check('UID change clears issued secret',await page.locator('#spSecret').inputValue().then(v=>v===''));
  await page.locator('#spId').fill('next_station');await page.locator('#spName').fill('תחנה נוספת');await page.locator('#spDistrict').selectOption('south');
  await page.evaluate(()=>{window.delay=new Promise(resolve=>window.releaseDelayed=resolve);});
  await page.locator('#spCreate').click();await page.waitForFunction(()=>calls.at(-1).payload.station_id==='next_station');
  await page.evaluate(()=>{switchActor('super3');window.releaseDelayed();window.delay=null;});
  await page.waitForTimeout(50);
  check('late previous-UID response cannot repopulate status or invitation controls',await page.evaluate(()=>document.getElementById('spStatus').textContent===''&&document.getElementById('spInviteForm').classList.contains('hide')));
  await page.close();

  const login=await pageFor('login.html');const lp=login.page;
  const loginCode=between(login.html,"let invitationEpoch=0",'function show(text, kind)');
  await lp.addScriptTag({content:`
    const $=id=>document.getElementById(id);let onboarding=false;let serial=0;
    const newRequestId=()=> 'invitation_request_'+(++serial);
    const pwOk=p=>p.length>=8;const hasServerAssignment=c=>!!c.role;
    window.calls=[];window.verifyCount=0;window.legacyWrites=0;window.nextError=false;
    const auth={currentUser:null};
    const makeUser=uid=>({uid,email:'invite@example.invalid',emailVerified:false,getIdToken:async()=>{},getIdTokenResult:async()=>({claims:{email_verified:true}})});
    const createUserWithEmailAndPassword=async()=>{auth.currentUser=makeUser('member1');return{user:auth.currentUser};};
    const signInWithEmailAndPassword=createUserWithEmailAndPassword;
    const sendEmailVerification=async()=>{verifyCount++;};const reload=async()=>{};
    const startRoute=async()=>{};
    const callRedeemInvitation=async payload=>{calls.push(JSON.parse(JSON.stringify(payload)));if(nextError){nextError=false;throw new Error('connection lost');}return{data:{ok:true}};};
    ${loginCode}
    window.verifyAccount=()=>auth.currentUser.emailVerified=true;
    window.switchActor=uid=>{const user=uid?makeUser(uid):null;auth.currentUser=user;if(invitationUid&&invitationUid!==(user?.uid||''))clearInvitation();invitationUid=user?.uid||'';invitationControls();};
    invitationControls();
  `});
  await lp.locator('#invitationPanel > summary').click();
  await lp.locator('#invitationEmail').fill('invite@example.invalid');await lp.locator('#invitationPassword').fill('Password123');await lp.locator('#invitationCreate').click();
  await lp.waitForFunction(()=>document.getElementById('invitationStatus').textContent.includes('החשבון מחובר'));
  check('invited account creation uses no legacy request path',!loginCode.includes('registration_requests')&&await lp.evaluate(()=>legacyWrites===0));
  await lp.locator('#invitationVerify').click();await lp.waitForFunction(()=>verifyCount===1);
  check('verification is explicit',await lp.evaluate(()=>verifyCount===1&&calls.length===0));
  await lp.locator('#invitationId').fill('invite_test');await lp.locator('#invitationSecret').fill('secret_mock_only');
  await lp.locator('#invitationRedeem').click();await lp.waitForFunction(()=>document.getElementById('invitationStatus').textContent.includes('טרם')||document.getElementById('invitationStatus').textContent.includes('עדיין לא אומתה'));
  check('unverified identity never reaches redeem',await lp.evaluate(()=>calls.length===0));
  await lp.evaluate(()=>{verifyAccount();window.nextError=true;});await lp.locator('#invitationRedeem').click();await lp.waitForFunction(()=>document.getElementById('invitationStatus').textContent.includes('connection lost'));
  await lp.locator('#invitationRedeem').click();await lp.waitForFunction(()=>document.getElementById('invitationStatus').textContent.includes('ההזמנה מומשה'));
  check('redeem exact retry preserves request and secret',await lp.evaluate(()=>JSON.stringify(calls[0])===JSON.stringify(calls[1])));
  check('redeem input contains only three contract keys',await lp.evaluate(()=>Object.keys(calls[0]).sort().join(',')==='invite_id,request_id,secret'));
  check('success clears secret and makes no grant claim',await lp.locator('#invitationSecret').inputValue().then(v=>v==='')&&await lp.locator('#invitationStatus').textContent().then(s=>s.includes('עדיין לא הוענקו הרשאות')));
  await screenshot(lp,'login-invitation','invitationPanel');
  await lp.locator('#invitationSecret').fill('new_secret');await lp.evaluate(()=>switchActor('member2'));
  check('member UID change clears secret',await lp.locator('#invitationSecret').inputValue().then(v=>v===''));
  await lp.close();
  console.log('Onboarding UI browser: '+passed+' passed (actual handlers, mock services).');
}finally{await browser.close();}
