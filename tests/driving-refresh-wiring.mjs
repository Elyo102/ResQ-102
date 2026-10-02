import fs from 'node:fs';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8'),require=createRequire(import.meta.url);let checks=0;
const nav=read('nav.js'),index=read('functions/index.js'),rules=read('firestore.rules'),browser=read('driving-refresh.js'),sw=read('firebase-messaging-sw.js');
assert.match(nav,/href: 'driving-refresh.html'.*group: 'mine'/);checks++;
for(const name of ['getDrivingRefreshContext','saveDrivingRefreshReport','listDrivingRefreshReports','getDrivingRefreshSummary']){assert.ok(index.includes('exports.'+name+' = onCall(DRIVING_REFRESH_OPTIONS'));checks++;}
assert.match(index,/DRIVING_REFRESH_OPTIONS = \{enforceAppCheck:true/);checks++;
assert.match(rules,/match \/driving_refresh_reports\/\{reportId\}[\s\S]*?allow read, write: if false;[\s\S]*?match \/edits\/\{editId\} \{ allow read, write: if false; \}/);checks++;
assert.ok(!browser.includes('localStorage'));assert.ok(!browser.includes('seedUsers'));assert.ok(!browser.includes('innerHTML'));checks+=3;
for(const p of ['driving-refresh.html','driving-refresh.js','driving-refresh.css']){assert.ok(sw.includes("'./"+p+"'"));assert.ok(JSON.parse(read('tests/public-assets.json')).includes(p));checks+=2;}
const policy=require('../functions/backup-policy.js');for(const p of ['stations/{sid}/driving_refresh_reports/{id}','stations/{sid}/driving_refresh_reports/{id}/edits/{eid}']){assert.ok(policy.getPolicy(p));checks++;}
const indexes=JSON.parse(read('firestore.indexes.json'));assert.equal(indexes.indexes.filter(x=>x.collectionGroup==='driving_refresh_reports').length,4);checks++;
const scripts=JSON.parse(read('tests/package.json')).scripts;assert.ok(scripts.all.includes('npm run driving:refresh'));assert.ok(scripts['driving:refresh'].includes('driving-refresh-browser.mjs'));checks+=2;
console.log('DRIVING_REFRESH_WIRING_PASS',checks,'source/registration assertions (not runtime security proof)');
