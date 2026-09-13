import assert from 'node:assert/strict'
import { zeroAmountAction } from '../src/bank-import-policy.ts'
assert.equal(zeroAmountAction(0), 'ignore')
assert.equal(zeroAmountAction(0, {status:'pending'}), 'ignore')
assert.equal(zeroAmountAction(0, {status:'rejected',decision_reason:'zero_amount'}), 'ignore')
assert.equal(zeroAmountAction(199, {status:'rejected',decision_reason:'zero_amount'}), 'reopen')
assert.equal(zeroAmountAction(199, {status:'rejected',decision_reason:null}), 'unchanged')
assert.equal(zeroAmountAction(199, {status:'matched',decision_reason:'zero_amount'}), 'unchanged')
assert.equal(zeroAmountAction(199, {status:'approved'}), 'unchanged')
assert.equal(zeroAmountAction(199), 'unchanged')
console.log('Zero-value exclusions and nonzero reactivation passed')
