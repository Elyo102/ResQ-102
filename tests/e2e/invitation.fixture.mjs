import { test as base, expect } from 'playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:41996';
const source = fs.readFileSync(path.join(root, 'login.html'), 'utf8');
const start = source.indexOf('let invitationEpoch=0');
const end = source.indexOf('function show(text, kind)', start);
if (start < 0 || end <= start) throw new Error('Invitation source anchors changed; review fixture');
const handler = source.slice(start, end);
const inputs = { 'login.html': createHash('sha256').update(source).digest('hex') };
const banner = fs.readFileSync(path.join(root, 'resq-banner.jpg'));
inputs['resq-banner.jpg'] = createHash('sha256').update(banner).digest('hex');
// Actual markup/styles and handler, isolated from Firebase/Auth/mail/PWA bootstrap.
// This is a component-browser fixture, NOT authenticated end-to-end acceptance.
const markup = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*>/gi, tag => {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1] || '';
    if (!/\.css(?:\?|$)/i.test(href) || /^(?:https?:|\/\/)/i.test(href)) return '';
    const file = path.resolve(root, href.split('?')[0]);
    if (!file.startsWith(root) || !fs.existsSync(file)) throw new Error('Unexpected stylesheet');
    const text = fs.readFileSync(file, 'utf8');
    inputs[path.relative(root, file)] = createHash('sha256').update(text).digest('hex');
    return '<style>' + text + '</style>';
  });

export const test = base.extend({
  invitation: async ({ browser }, use, info) => {
    const contexts = [], diagnostics = [];
    async function open(identity) {
      const context = await browser.newContext({ ...info.project.use, serviceWorkers: 'block' });
      contexts.push(context);
      // Register before navigation and cover every page in every isolated identity.
      context.on('page', page => {
        page.on('console', msg => { if (['warning', 'error'].includes(msg.type())) diagnostics.push(msg.type() + ': ' + msg.text()); });
        page.on('pageerror', error => diagnostics.push('pageerror: ' + error.message));
        page.on('requestfailed', request => diagnostics.push('requestfailed: ' + request.url()));
      });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/login.html') {
          return route.fulfill({ contentType: 'text/html', body: markup });
        }
        if (url.origin === origin && url.pathname === '/resq-banner.jpg') {
          return route.fulfill({ contentType: 'image/jpeg', body: banner });
        }
        // Never contact production or any external service, even on fixture drift.
        diagnostics.push('unexpected request: ' + url.origin + url.pathname);
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto(origin + '/login.html');
      await page.evaluate(() => {
        document.body.classList.add('art', 'ready');
        document.body.style.animation = 'none';
        document.body.style.opacity = '1';
        for (const id of ['bootView', 'waitView', 'homeView', 'pwView']) document.getElementById(id)?.classList.add('hide');
        document.getElementById('authView').classList.remove('hide');
        const panel = document.getElementById('invitationPanel');
        panel.classList.remove('hide'); panel.open = true;
      });
      await page.addScriptTag({ content: `
        const $=id=>document.getElementById(id);let onboarding=false,loginTransitionPending=false,serial=0;
        const newRequestId=()=> 'synthetic_request_'+(++serial);
        const pwOk=p=>p.length>=8;const hasServerAssignment=c=>!!c.role;
        const state=window.fixture={calls:[],failure:false,hold:false,routes:0};
        const makeUser=uid=>({uid,email:uid+'@example.invalid',emailVerified:false,
          getIdToken:async()=>{},getIdTokenResult:async()=>({claims:{email_verified:true}})});
        const auth={currentUser:null};
        const createUserWithEmailAndPassword=async()=>{auth.currentUser=makeUser(${JSON.stringify(identity)});return{user:auth.currentUser};};
        const signInWithEmailAndPassword=createUserWithEmailAndPassword;
        const sendEmailVerification=async()=>{};const reload=async()=>{};const callReset=async()=>{};
        const startRoute=async()=>{state.routes++;};
        const callRedeemInvitation=async payload=>{
          state.calls.push(structuredClone(payload));
          if(state.hold)await new Promise(resolve=>state.release=resolve);
          if(state.failure){state.failure=false;throw new Error('Synthetic response lost');}
          return{data:{ok:true}};
        };
        ${handler}
        state.verify=()=>auth.currentUser.emailVerified=true;
        state.switchActor=uid=>{auth.currentUser=uid?makeUser(uid):null;clearInvitation();invitationUid=uid||'';};
        invitationControls();
      ` });
      return { page, context };
    }
    try { await use({ open }); }
    finally {
      for (const context of contexts) await context.close();
      await info.attach('source-and-diagnostics', {
        body: JSON.stringify({ scope: 'isolated real invitation handler; mocked services', inputs, diagnostics }, null, 2),
        contentType: 'application/json'
      });
      expect(diagnostics, 'No unexpected browser warning/error/request').toEqual([]);
      for (const [file, hash] of Object.entries(inputs)) {
        expect(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), 'Source changed during test: ' + file).toBe(hash);
      }
    }
  }
});
export { expect };
