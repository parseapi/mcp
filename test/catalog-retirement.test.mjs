import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';

const retired = ['bank','iban','ach','routing','bank_us_ach','bank_requirements','iban_requirements','ach_requirements','provider','npi','vat','bloc','bloc_countries','tariff','tariff_search','tariff_calculate','tariff_calculate_batch','tariff_coverage','tariff_changes','tariff_remedies','tariff_fee_estimates'];
for (const transport of ['stdio', 'http']) for (const mode of ['full', 'compact']) {
 test(`retired catalog tools cannot dispatch an API call over ${transport}/${mode}`, async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected retired API call'); });
  const rpc = await connect('fixture_key', transport, { mode });
  t.after(() => rpc.close());
  const listed = await rpc.request('tools/list', {});
  for (const name of retired) {
   assert.equal(listed.result.tools.some(tool => tool.name === name), false, name);
   const result = await rpc.call(mode === 'compact' ? 'lookup' : name, mode === 'compact' ? { operation: name, arguments: {} } : {});
   assert.equal(body(await rpc.call('discover', { operation: name })).code, 'invalid_request', name);
   assert.ok(result.error || result.result?.isError, name);
  }
  assert.equal(calls, 0);
 });
}
