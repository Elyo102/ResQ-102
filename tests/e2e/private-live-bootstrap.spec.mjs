import {test,expect} from '../lib/contained-test.mjs';
import {readFileSync} from 'node:fs';
const base=new URL('../../control-plane/web/',import.meta.url);
const assets=new Set(['index.html','bootstrap.mjs','firebase-adapter.mjs','firebase-config.mjs','private-controller.mjs','private-view.mjs','private.css','dispatch-model.mjs','dispatch-view.mjs','active-tasks-model.mjs','active-tasks-view.mjs']);
test('staged real bootstrap loads, shows owner login, and honestly denies disabled owner',async({page})=>{
 const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('request',request=>requests.push(request.url()));
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin==='https://accounts.google.com' && u.pathname==='/gsi/client'){
   await route.fulfill({contentType:'text/javascript',body:`
window.google={accounts:{oauth2:{initTokenClient(options){return {requestAccessToken(){window.__gisGesture=navigator.userActivation.isActive;queueMicrotask(()=>options.callback({access_token:'synthetic-token'}));}};}}}};
`});return;
  }
  if(u.origin==='https://www.gstatic.com' && /^\/firebasejs\/11\.10\.0\/firebase-(app|auth|firestore)\.js$/.test(u.pathname)){
   await route.fulfill({contentType:'text/javascript',body:`
const state=window.__sdk ||= {currentUser:null,listener:null};
export const initializeApp=()=>({}),getAuth=()=>state,setPersistence=async()=>{},browserSessionPersistence='session';
export const memoryLocalCache=()=>({}),initializeFirestore=()=>({}),collection=()=>({}),query=()=>({}),orderBy=()=>({}),limit=()=>({});
export const doc=()=>({}),getDocFromServer=async()=>{throw Error('permission-denied');};
export class GoogleAuthProvider{static credential(id,token){if(id!==null||token!=='synthetic-token')throw Error('INVALID_SYNTHETIC_CREDENTIAL');return {};}}
export const onIdTokenChanged=(a,fn)=>{state.listener=fn;queueMicrotask(()=>fn(null));return()=>{};};
export const signInWithCredential=async()=>{state.currentUser={uid:'synthetic-owner',email:'owner@example.test',emailVerified:true,providerData:[{providerId:'google.com'}]};state.listener(state.currentUser);return{user:state.currentUser};};
export const signOut=async()=>{state.currentUser=null;state.listener(null);};
export const onSnapshot=(q,options,next,error)=>{queueMicrotask(()=>error({code:'permission-denied'}));return()=>{};};
`});return;
  }
  const file=u.pathname.split('/').pop();
  if(u.origin==='http://localhost:41996' && assets.has(file)){
   await route.fulfill({body:readFileSync(new URL(file,base)),contentType:file.endsWith('.mjs')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});return;
  }
  await route.abort();
 });
 await page.goto('http://localhost:41996/status/index.html');
 await expect(page.locator('#private-login')).toBeVisible();
 await expect(page.locator('.agent')).toHaveCount(0);
 await page.locator('#private-login').click();
 await expect(page.locator('.health')).toContainText('אין הרשאה');
 await expect(page.locator('#dispatch-panel')).toHaveCount(1);await expect(page.locator('#dispatch-panel')).toBeHidden(); // mounted, hidden without backend authorization
 await expect(page.locator('#private-terminal')).not.toContainText('אות חיים');
 await expect(page.locator('#private-login')).toBeVisible();
 expect(await page.evaluate(()=>window.__gisGesture)).toBe(true);
 expect(requests.some(url=>url.includes('/__/auth/handler'))).toBe(false);
 expect(requests.some(url=>url==='https://accounts.google.com/gsi/client')).toBe(true);
 expect(errors).toEqual([]);
});
