import assert from 'node:assert/strict';
import {appCallback} from '../public/auth/ios/return.mjs';
const state='abcde123-1234-1234-1234-123456789abc';
const valid=`?state=${state}&neon_auth_session_verifier=one-time-code`;
assert.equal(appCallback(valid),`com.fraisejr.nextexpense://auth/callback${valid}`);
for(const query of ['', '?state=bad&neon_auth_session_verifier=x', valid+'&state='+state, valid+'&neon_auth_session_verifier=second',`?state=${state}`]) assert.equal(appCallback(query),null);
assert.equal(new URL(appCallback(valid+'&redirect_uri=https://evil.example')).host,'auth');
assert.equal(new URL(appCallback(`?state=${state}&error=denied`)).searchParams.get('error'),'sign_in_failed');
console.log('Callback validation passed');
