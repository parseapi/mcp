import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';

for (const transport of ['stdio', 'http']) for (const mode of ['full', 'compact']) {
	test(`Country postal guidance is Core and unchanged on ${transport}/${mode}`, async t => {
		const values = [
			{ country: 'US', postal_format: '#####', postal_regex: '^(?:\\d{5}(?:-\\d{4})?)$' },
			{ country: 'US', postal_format: null, postal_regex: null },
			{ country: 'US' },
		];
		let calls = 0;
		t.mock.method(globalThis, 'fetch', async (input, init) => {
			const url = new URL(String(input));
			assert.equal(url.pathname, '/country/US');
			assert.equal(url.search, '');
			assert.equal(new Headers(init.headers).get('X-API-Version'), '2.1.0');
			return new Response(JSON.stringify(values[calls++]));
		});
		const rpc = await connect('fixture', transport, { mode });
		t.after(() => rpc.close());
		const description = mode === 'compact'
			? body(await rpc.call('discover', { operation: 'country' })).operations[0].description
			: (await rpc.request('tools/list', {})).result.tools.find(tool => tool.name === 'country').description;
		assert.match(description, /postal_format guidance and postal_regex syntax checking on every plan/);
		assert.match(description, /do not establish assignment or deliverability/);
		for (const value of values) {
			const result = mode === 'compact'
				? await rpc.call('lookup', { operation: 'country', arguments: { code: 'US' } })
				: await rpc.call('country', { code: 'US' });
			assert.deepEqual(body(result), value);
		}
		assert.equal(calls, 3);
	});
}
