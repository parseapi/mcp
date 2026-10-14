import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { connect, body } from './helpers.mjs';

const cases = JSON.parse(readFileSync(new URL('./fixtures/measure-response.json', import.meta.url)));
for (const transport of ['stdio', 'http']) {
 for (const mode of ['full', 'compact']) {
  test(`Measure returns complete clean JSON on ${transport} ${mode}`, async t => {
   let fixture;
   t.mock.method(globalThis, 'fetch', async () => Response.json(fixture));
   const rpc = await connect('fixture', transport, { mode });
   t.after(() => rpc.close());
   for (fixture of cases) {
    const args = { measure: fixture.measure };
    const response = mode === 'full' ? await rpc.call('measure', args) : await rpc.call('lookup', { operation: 'measure', arguments: args });
    assert.deepEqual(body(response), fixture);
   }
  });
 }
}
