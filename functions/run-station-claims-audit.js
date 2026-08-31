'use strict';

// Read-only 42B release gate. This script prints aggregate counters only and
// never prints a uid, name, email, phone number or raw custom-claims object.
const admin = require('firebase-admin');
const claimsAudit = require('./count-station-claims');

const projectId = String(
  process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || ''
).trim();

async function main() {
  if (!projectId) {
    throw new Error('GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT is required');
  }
  if (admin.apps.length === 0) admin.initializeApp({ projectId:projectId });

  const users = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const user of page.users) {
      users.push({ disabled:user.disabled === true, customClaims:user.customClaims || {} });
    }
    pageToken = page.pageToken;
  } while (pageToken);

  const totals = claimsAudit.summarizeUsers(users);
  console.log(JSON.stringify(Object.assign({
    project:projectId,
    read_only:true
  }, totals)));
  if (totals.release_gate_42b !== 'PASS') process.exitCode = 2;
}

main().catch(function (error) {
  console.error('station_claim_audit_error: ' +
    String(error && error.message || 'unknown_error'));
  process.exitCode = 1;
});
