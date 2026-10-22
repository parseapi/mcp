import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from './helpers.mjs';

for (const transport of ['stdio', 'http']) {
 test(`retired Vehicle/VIN tools cannot call the API over ${transport}`, async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Retired supplier call'); });
  const rpc = await connect('test_key', transport);
  t.after(() => rpc.close());
  const listed = await rpc.request('tools/list', {});
  for (const name of ['vehicle', 'vin']) {
   assert.equal(listed.result.tools.some(tool => tool.name === name), false);
   const result = await rpc.call(name, { vin: '1HGCM82633A004352', deep: true });
   assert.ok(result.error || result.result?.isError, JSON.stringify(result));
  }
  assert.equal(calls, 0);
 });
}
