# ResQ staging foundation

Staging must use a separate Firebase project. Never point a preview or test UI at `station-102`.

## Safety defaults

- Only project ID `station-102` is treated as production by Cloud Functions.
- Every other project starts with outbound mode `sink` and schedulers disabled.
- Sink mode records attempted email and push delivery without contacting SMTP or FCM.
- Scheduled handlers exit immediately and log that they were skipped.
- Client and Service Worker Firebase configuration are generated from `config/environments.json`.
- Production and staging aliases are explicit; there is no default Firebase project.

## Prepare client configuration

1. Create a separate Firebase project and web app.
2. Replace every `REPLACE_WITH_STAGING_*` value in `config/environments.json`.
3. Run `node scripts/generate-client-config.mjs staging`.
4. Verify generated files contain no `station-102`, production VAPID key, production URL, or real email address.
5. Deploy only with an explicit staging project target.

Before a staging Functions deploy, set `RESQ_WEB_API_KEY` to the staging web app's public Firebase API key. Startup fails closed if a known non-production project has no key, so employee-number login cannot silently target the wrong project.

Before returning to production development, run `node scripts/generate-client-config.mjs production` and verify the working tree.

## Cloud configuration

Staging must not receive the production Gmail secret, Auth users, FCM tokens, App Check debug tokens, Sheets IDs, or production data. The mail trigger has no Gmail secret binding outside production and remains in sink mode. Use synthetic users and data only.

Any staging cloud creation, deployment, secret, App Check enforcement, canary email/push, scheduler change, or data write requires a separately approved cloud workflow.
