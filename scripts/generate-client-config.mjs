import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envName = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!['production', 'staging'].includes(envName)) {
  throw new Error('Usage: node scripts/generate-client-config.mjs production|staging');
}

const all = JSON.parse(fs.readFileSync(path.join(root, 'config/environments.json'), 'utf8'));
const cfg = all[envName];
const json = value => JSON.stringify(value, null, 2);

if (envName === 'production' && cfg.firebase.projectId !== 'station-102') {
  throw new Error('Production config must target station-102');
}
if (envName === 'staging' && (cfg.firebase.projectId === 'station-102' || /REPLACE_WITH/.test(JSON.stringify(cfg)))) {
  throw new Error('Staging config is incomplete or points to production');
}
if (checkOnly) {
  console.log(`Validated client config for ${envName}: ${cfg.firebase.projectId}; no files written.`);
  process.exit(0);
}

fs.writeFileSync(path.join(root, 'firebase-config.js'), `// Generated from config/environments.json. Do not edit by hand.\nexport const ENVIRONMENT = ${json(envName)};\nexport const ENVIRONMENT_LABEL = ${json(cfg.label)};\nexport const firebaseConfig = ${json(cfg.firebase)};\nexport const STATION_ID = ${json(cfg.stationId)};\nexport const DEFAULT_VAPID = ${json(cfg.vapidKey)};\nexport const RECAPTCHA_SITE_KEY = ${json(cfg.appCheckSiteKey)};\n\nexport function installEnvironmentBanner() {\n  if (ENVIRONMENT === 'production' || typeof document === 'undefined') return;\n  const show = () => {\n    if (document.getElementById('resq-environment-banner')) return;\n    const el = document.createElement('div');\n    el.id = 'resq-environment-banner';\n    el.textContent = ENVIRONMENT_LABEL || 'סביבת בדיקות';\n    el.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:50%;' +\n      'transform:translateX(-50%);background:#ffd43b;color:#111;padding:5px 14px;' +\n      'font:700 13px Arial;border-radius:0 0 8px 8px;box-shadow:0 2px 8px #0006';\n    document.body.appendChild(el);\n  };\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);\n  else show();\n}\n\ninstallEnvironmentBanner();\n`);

fs.writeFileSync(path.join(root, 'firebase-sw-config.js'), `// Generated from config/environments.json. Do not edit by hand.\nself.RESQ_ENVIRONMENT = ${json(envName)};\nself.RESQ_FIREBASE_CONFIG = ${json(cfg.firebase)};\n`);

console.log(`Generated client config for ${envName}: ${cfg.firebase.projectId}`);
