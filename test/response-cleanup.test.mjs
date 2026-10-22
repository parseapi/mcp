import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { body, connect } from './helpers.mjs';

// Captured from ordinary API candidate handlers, without a response preference.
const cases = [
  ['timezones', 'time_zones', { query: 'New York', details: true }],
  ['time', 'time', { iata: 'JFK', at: '2026-10-13T16:00:00Z', deep: true }],
  ['emoji-metadata', 'emoji_metadata', {}],
  ['company-coverage', 'company_coverage', {}],
  ['company-profile', 'company_id', { id: 'co_222222222222', deep: true }],
];
for (const transport of ['stdio', 'http']) for (const mode of ['full', 'compact']) {
  test(`ordinary cleaned payloads pass through ${transport}/${mode}`, async t => {
    let expected;
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_input, init) => {
      requests++;
      const headers = new Headers(init.headers);
      assert.equal(headers.get('Parse-Version'), '2.0.0');
      assert.equal(headers.get('Parse-Response'), null);
      return Response.json(expected);
    });
    const rpc = await connect('fixture', transport, { mode });
    t.after(() => rpc.close());
    for (const [fixture, operation, args] of cases) {
      expected = JSON.parse(readFileSync(new URL(`./fixtures/response-cleanup/${fixture}.json`, import.meta.url)));
      const result = mode === 'compact' ? await rpc.call('lookup', { operation, arguments: args }) : await rpc.call(operation, args);
      assert.equal(result.result?.isError, undefined, `${operation}: ${JSON.stringify(result)}`);
      assert.deepEqual(body(result), expected, operation);
    }
    assert.equal(requests, cases.length);
  });
}
test('ordinary discovery describes useful facts without retired source metadata', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Unexpected dispatch'); });
  const rpc = await connect(null, 'stdio');
  t.after(() => rpc.close());
  const policy = body(await rpc.call('discover', { operation: 'time' })).operations[0].policy;
  assert.equal(Object.hasOwn(policy.freshness, 'timezone_database_version'), false);
  assert.equal(policy.freshness.cache_control, 'no-store');
  assert.equal(policy.billing.deep_extra_units, 0);
  assert.equal(requests, 0);
});
