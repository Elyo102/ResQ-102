// Environment scrub for the listener runner (LD only). Push-trigger review, key condition (CRITICAL):
// the FIRST statement of the runner's main() calls scrubSecretEnv(), before readConfig/readCredential/readLlmKey.
// - Deletes from process.env every variable that could carry a key, token or secret (LLM keys, cloud credentials,
//   GitHub tokens, ...) and every proxy variable (gRPC/HTTP must never take a proxy from the environment).
// - Returns ONLY the minimal child env for the DPAPI helper (SystemRoot, windir, TEMP, USERPROFILE, PATH).
// - Returns the NAMES removed as a count only; values are never read into a log or returned.
// Condition 1 of the 25572dc code review (MUST): some variables change TLS or routing and are read BEFORE the scrub
// could remove them — grpc-js tls-helpers reads GRPC_SSL_CIPHER_SUITES / GRPC_DEFAULT_SSL_ROOTS_FILE_PATH at import
// time; Node reads NODE_OPTIONS, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE/SSL_CERT_DIR at process start and
// NODE_TLS_REJECT_UNAUTHORIZED at connect time. unsafeEnvNames() finds them; the runner's FIRST statement refuses to
// start (EXIT.STARTUP, code UNSAFE_ENV, names only — never values). grpc-transport is imported dynamically only after it.
// This is the ONLY listener module allowed to touch process.env (static guard in listener-runner.test.mjs).
import {minimalChildEnv} from './win-protect.mjs';

export const SECRET_ENV=/(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|^XAI|^OPENAI|^ANTHROPIC|^GEMINI|^GOOGLE_|^GCLOUD|^FIREBASE|^GH_|^GITHUB|^AWS_|^AZURE_)/i;
export const PROXY_ENV=/^(?:https?_proxy|grpc_proxy|all_proxy|no_proxy|no_grpc_proxy)$/i;
export const UNSAFE_ENV=/^(?:GRPC_.*|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|https_proxy|http_proxy|grpc_proxy|all_proxy)$/i;
// Names only (sorted); the values are never read.
export function unsafeEnvNames(env=process.env){return Object.keys(env).filter(name=>UNSAFE_ENV.test(name)).sort();}
export function scrubSecretEnv(env=process.env){
  let removed=0;
  for(const name of Object.keys(env)){
    if(SECRET_ENV.test(name)||PROXY_ENV.test(name)||UNSAFE_ENV.test(name)){delete env[name];removed++;}
  }
  return Object.freeze({childEnv:Object.freeze(minimalChildEnv(env)),removed});
}
