// Environment scrub for the listener runner (LD only). Push-trigger review, key condition (CRITICAL):
// the FIRST statement of the runner's main() calls scrubSecretEnv(), before readConfig/readCredential/readLlmKey.
// - Deletes from process.env every variable that could carry a key, token or secret (LLM keys, cloud credentials,
//   GitHub tokens, ...) and every proxy variable (gRPC/HTTP must never take a proxy from the environment).
// - Returns ONLY the minimal child env for the DPAPI helper (SystemRoot, windir, TEMP, USERPROFILE, PATH).
// - Returns the NAMES removed as a count only; values are never read into a log or returned.
// This is the ONLY listener module allowed to touch process.env (static guard in listener-runner.test.mjs).
import {minimalChildEnv} from './win-protect.mjs';

export const SECRET_ENV=/(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|^XAI|^OPENAI|^ANTHROPIC|^GEMINI|^GOOGLE_|^GCLOUD|^FIREBASE|^GH_|^GITHUB|^AWS_|^AZURE_)/i;
export const PROXY_ENV=/^(?:https?_proxy|grpc_proxy|all_proxy|no_proxy|no_grpc_proxy)$/i;
export function scrubSecretEnv(env=process.env){
  let removed=0;
  for(const name of Object.keys(env)){
    if(SECRET_ENV.test(name)||PROXY_ENV.test(name)||/^NODE_OPTIONS$/i.test(name)){delete env[name];removed++;}
  }
  return Object.freeze({childEnv:Object.freeze(minimalChildEnv(env)),removed});
}
