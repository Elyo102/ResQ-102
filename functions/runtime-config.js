'use strict';

const PRODUCTION_PROJECT_ID = 'station-102';
function firebaseConfigProject() {
  try { return JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId || ''; }
  catch (_) { return ''; }
}
const projectId = String(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || firebaseConfigProject()).trim();
const isProduction = projectId === PRODUCTION_PROJECT_ID;

function value(name, productionDefault, stagingDefault) {
  const explicit = process.env[name];
  if (explicit != null && String(explicit).trim() !== '') return String(explicit).trim();
  return isProduction ? productionDefault : stagingDefault;
}

const config = Object.freeze({
  projectId,
  environment: isProduction ? 'production' : 'staging',
  isProduction,
  outboundMode: value('RESQ_OUTBOUND_MODE', 'live', 'sink'),
  schedulersEnabled: value('RESQ_SCHEDULERS_ENABLED', 'true', 'false') === 'true',
  stationId: value('RESQ_STATION_ID', 'eilat_102', 'staging_station'),
  stationName: value('RESQ_STATION_NAME', 'תחנה 102', 'תחנת בדיקות'),
  siteUrl: value('RESQ_SITE_URL', 'https://elyo102.github.io/ResQ-102', ''),
  webApiKey: value('RESQ_WEB_API_KEY', 'AIzaSyDY13rUZCN0q2Izo8i59JHKmWvnu_0Tw7Q', ''),
  superAdminEmail: value('RESQ_SUPER_ADMIN_EMAIL', 'fire102.shits@gmail.com', ''),
  hrEmail: value('RESQ_HR_EMAIL', 'lisaa@102.gov.il', ''),
  hrName: value('RESQ_HR_NAME', 'ליסה עגיב', 'רכזת בדיקות'),
  mailFromName: value('RESQ_MAIL_FROM_NAME', 'ResQ · תחנה 102', 'ResQ · בדיקות'),
  mailFromAddress: value('RESQ_MAIL_FROM_ADDRESS', 'fire102.shits@gmail.com', '')
});

if (!config.isProduction && config.outboundMode === 'live') {
  throw new Error('Staging cannot start with RESQ_OUTBOUND_MODE=live');
}
if (!config.isProduction && config.schedulersEnabled) {
  throw new Error('Staging cannot start with schedulers enabled');
}
if (config.projectId && !config.isProduction && !config.webApiKey) {
  throw new Error('Staging requires RESQ_WEB_API_KEY for employee-number login');
}

module.exports = config;
