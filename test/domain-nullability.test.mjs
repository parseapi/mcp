import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';

for (const transport of ['stdio', 'http']) for (const mode of ['full', 'compact']) {
  test(`ordinary domain preserves unknown and known signing over ${transport}/${mode}`, async t => {
    let answer, calls = 0;
    t.mock.method(globalThis, 'fetch', async input => {
      calls++; const url = new URL(String(input));
      assert.equal(url.pathname, '/domain/example.com'); assert.equal(url.search, '?deep=true');
      return Response.json(answer);
    });
    const rpc = await connect('fixture', transport, { mode }); t.after(() => rpc.close());
    for (const available of [null, false, true]) for (const signing of [{}, { dnssec: null }, { dnssec: false }, { dnssec: true }]) {
      answer = { domain: 'example.com', available, deep: available === null ? {} : { registration: available ? { registered: false } : { registered: true, ...signing } } };
      const args = { domain: 'example.com', deep: true };
      const previous = calls;
      const response = mode === 'compact' ? await rpc.call('lookup', { operation: 'domain', arguments: args }) : await rpc.call('domain', args);
      assert.deepEqual(body(response), answer); assert.equal(calls, previous + 1);
    }
  });
}
