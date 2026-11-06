import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';

for (const transport of ['stdio', 'http']) for (const mode of ['full', 'compact']) test(`legacy BIN operation is absent while Card stays discoverable: ${transport}/${mode}`, async t => {
 let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; assert.fail('Metadata and removed operations must not call HTTP'); });
 const rpc = await connect(null, transport, { mode }); t.after(() => rpc.close());
 const tools = (await rpc.request('tools/list', {})).result.tools;
 assert.ok(!tools.some(tool => tool.name === 'bin'));
 const card = body(await rpc.call('discover', { operation: 'card' })).operations[0];
 assert.deepEqual(card.inputSchema.required, ['bin']);
 assert.equal(body(await rpc.call('discover', { operation: 'bin' })).code, 'invalid_request');
 if (mode === 'compact') assert.equal(body(await rpc.call('lookup', { operation: 'bin', arguments: { bin: '424242' } })).code, 'invalid_request');
 assert.equal(calls, 0);
});
