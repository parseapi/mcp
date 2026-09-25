import assert from 'node:assert/strict';
import { test } from 'node:test';
import { body, connect } from './helpers.mjs';
import catalog from '../src/agent-catalog.json' with { type: 'json' };

const record = { bin:'51', brand:'mastercard', brand_name:'Mastercard', logo:'https://cdn.parseapi.com/card/mastercard.svg' };
const invalid = ['4242424242424242', '123456789012', '1', '', '------',
	'424242x', '４２４２４２', '٤٢٤٢٤٢', '\u00a0424242', '424242\u2003',
	'424\v242', '424\f242', '424\u0000242', '424–242', '424%20242',
	' '.repeat(59) + '424242', 424242, null, ['424242']];
const valid = ['51', '411', '4111', '41111', '001234', '00123456', '00123456789', ' 00\t12\r34\n-56 ',
	' '.repeat(58) + '424242'];

test('API errors without Retry-After keep their original shape', async t => {
	const error = { code: 'not_found', message: 'No match', docs: null, request_id: 'req_missing' };
	t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(error), { status: 404 }));
	const rpc = await connect('test_key', 'http');
	t.after(() => rpc.close());
	assert.deepEqual(body(await rpc.call('city', { name: 'missing' })), error);
});

for (const transport of ['stdio', 'http']) {
	for (const mode of ['full', 'compact']) {
		test(`Card validates prefixes before dispatch (${transport}, ${mode})`, async t => {
			const calls = [];
			t.mock.method(globalThis, 'fetch', async (input, init) => {
				calls.push({ url: new URL(input), init });
				return new Response(JSON.stringify(record));
			});
			const rpc = await connect('test_key', transport, { mode });
			t.after(() => rpc.close());
			const card = args => mode === 'full' ? rpc.call('card', args)
				: rpc.call('lookup', { operation: 'card', arguments: args });
			for (const bin of invalid) {
				const result = await card({ bin });
				assert.equal(result.result?.isError, true);
				if (typeof bin === 'string' && bin.length >= 6) {
					assert.ok(!JSON.stringify(result).includes(JSON.stringify(bin).slice(1, -1)), 'Rejected input must not be echoed');
				}
			}
			assert.equal((await card({})).result?.isError, true);
			assert.equal(calls.length, 0, 'Rejected input must never reach fetch');
			for (const bin of valid) {
				assert.deepEqual(body(await card({ bin })), record);
				assert.equal(decodeURIComponent(calls.at(-1).url.pathname.slice('/card/'.length)), bin);
				assert.equal(calls.at(-1).url.search, '');
				assert.equal(new Headers(calls.at(-1).init.headers).get('Parse-Version'), '2.0.0');
			}
			const detail = body(await rpc.call('discover', { operation: 'card' })).operations[0];
			assert.deepEqual(Object.keys(detail.inputSchema.properties), ['bin', 'deep']);
			assert.equal(detail.inputSchema.properties.bin.maxLength, 64);
			assert.equal(typeof detail.inputSchema.properties.bin.pattern, 'string');
			assert.equal(detail.policy_available, true);
			assert.deepEqual(detail.policy, catalog.operations.card);
			assert.equal(detail.policy.operation, 'card');
			assert.deepEqual(detail.policy.input_schema.required, ['bin']);
			for (const field of ['type', 'maxLength', 'pattern']) {
				assert.equal(detail.policy.input_schema.properties.bin[field], detail.inputSchema.properties.bin[field]);
			}
			assert.match(detail.policy.uncertainty.bin.value, /compare deep.prefix to this value/);
			assert.match(detail.policy.uncertainty['deep.prefix'].null, /HTTP 200/);
			assert.match(detail.policy.uncertainty['deep.prefix'].equals_bin, /fields can still be null/);
			assert.match(detail.policy.uncertainty['deep.prefix'].shorter_than_bin, /broader reference match/i);
			assert.match(detail.policy.uncertainty['deep.metadata'].null, /never backfill/);
			assert.equal(detail.policy.uncertainty['deep.prepaid'].null, 'Unknown, not false');
			assert.equal(detail.policy.freshness.mixed_source_ages, true);
			assert.equal(detail.policy.freshness.actual_age_seconds, null);
			assert.equal(detail.policy.access.effective_access, null);
			assert.equal(detail.policy.billing.monetary_quote, null);
			assert.equal(detail.policy.retry.successful_unknown_retried, false);
			assert.equal(detail.policy.docs.help, 'https://api.parseapi.com/version/2.0.0/card/help');
			assert.equal(calls.length, valid.length, 'Discovery must not make another API request');
			await card({ bin:'51', deep:true });
			assert.equal(calls.at(-1).url.search, '?deep=true');
		});
	}
}

for (const mode of ['full', 'compact']) {
	test(`Long Retry-After returns actionable metadata without early retries (${mode})`, async t => {
		let calls = 0;
		let retryAfter = '60';
		let status = 429;
		const error = { code: 'rate_limited', message: 'Try later', docs: null, request_id: 'req_retry' };
		t.mock.method(globalThis, 'fetch', async () => {
			calls++;
			return new Response(JSON.stringify(error), { status, headers: { 'Retry-After': retryAfter } });
		});
		const rpc = await connect('test_key', 'http', { mode });
		t.after(() => rpc.close());
		const card = () => mode === 'full' ? rpc.call('card', { bin: '424242' })
			: rpc.call('lookup', { operation: 'card', arguments: { bin: '424242' } });
		for (const value of ['60', new Date(Date.now() + 60_000).toUTCString()]) {
			retryAfter = value;
			const before = calls;
			const result = await card();
			assert.equal(result.result.isError, true);
			assert.deepEqual(body(result), { ...error, retry_after: value });
			assert.equal(calls - before, 1);
			status = 503;
		}
		retryAfter = '0';
		const before = calls;
		assert.deepEqual(body(await card()), { ...error, retry_after: '0' });
		assert.equal(calls - before, 3, 'Immediate retries still obey the ordinary retry budget');
	});
}
