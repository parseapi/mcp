import assert from 'node:assert/strict';
import { test } from 'node:test';
import { body, connect } from './helpers.mjs';

for (const transport of ['stdio', 'http']) {
	for (const mode of ['full', 'compact']) {
		test(`NPI keeps source uncertainty and invalid-input verdicts (${transport}, ${mode})`, async t => {
			const calls = [];
			let record;
			t.mock.method(globalThis, 'fetch', async (input, init) => {
				calls.push({ url: new URL(input), init });
				return new Response(JSON.stringify(record));
			});
			const rpc = await connect('test_key', transport, { mode });
			t.after(() => rpc.close());
			const lookup = args => mode === 'full' ? rpc.call('provider', args)
				: rpc.call('lookup', { operation: 'provider', arguments: args });
			for (const npi of ['188101%208208', '188101%25208208', 'hello', '(188) 101-8208']) {
				record = { npi, valid: false, registered: null, active: null, excluded: null };
				assert.deepEqual(body(await lookup({ npi })), record);
				assert.equal(decodeURIComponent(calls.at(-1).url.pathname.slice('/provider/'.length)), npi);
				assert.equal(calls.at(-1).url.search, '');
				assert.equal(new Headers(calls.at(-1).init.headers).get('Parse-Version'), '2.0.0');
			}
			const core = { npi: '1881018208', valid: true, registered: true, active: null, excluded: null, country: null };
			for (const extra of [{}, { deep: {} },
				{ deep: { deactivated_at: null, medicare: null, opt_out: null, enrollments: null } },
				{ deep: { deactivated_at: null, medicare: true, opt_out: false, enrollments: null } },
				{ deep: { deactivated_at: null, medicare: false, opt_out: false, enrollments: [] } },
				{ deep: { deactivated_at: null, medicare: true, opt_out: null,
					enrollments: [{ type: 'future_type', specialty: null, state: null }] } },
			]) {
				record = { ...core, ...extra };
				assert.deepEqual(body(await lookup({ npi: core.npi, deep: true })), record);
				assert.equal(calls.at(-1).url.search, '?deep=true');
			}
			const detail = body(await rpc.call('discover', { operation: 'provider' })).operations[0];
			assert.match(detail.description, /format\/checksum only/);
			assert.match(detail.description, /stored/);
			assert.match(detail.description, /not complete exclusion clearance/);
			assert.match(detail.inputSchema.properties.deep.description, /Free returns \{\}/);
		});
	}
}
