const APP = { name:'stub' };
let initialized = false;
export function initializeApp(){ initialized = true; return APP; }
export function getApps(){ return initialized ? [APP] : []; }
export function getApp(){ if (!initialized) throw new Error('no-app'); return APP; }
