import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyProviderWiringAttestation } = require('../functions/provider-wiring-attestation.js');
// Deliberately use the deployed module's real files, not a test reader.
// Generation is a separate release action after boundary tests pass.
const result = verifyProviderWiringAttestation();
assert.equal(result.valid, true, `Provider source receipt blocked release: ${result.reason}`);
console.log(`Provider source receipt PASS: ${result.reason}`);
