import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { connect, body, publicSurface } from './helpers.mjs';
import { cases } from './cases.mjs';

const response = (data, status = 200) => new Response(JSON.stringify(data), {
	status, headers: { 'content-type': 'application/json', 'retry-after': '0' },
});
async function setup(t, { key = 'test_key', transport = 'http', mode = 'compact', fetch } = {}) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (input, init) => {
		calls.push({ url: new URL(String(input)), init });
		return fetch ? fetch(calls.at(-1)) : response({ future: null, zero: 0, negative: false, empty: [], deep: {} });
	});
	const rpc = await connect(key, transport, { mode });
	t.after(() => rpc.close());
	return { rpc, calls };
}

test('compact catalog advertises three tools and full preserves every lookup schema', async (t) => {
	const { rpc, calls } = await setup(t);
	const compact = (await rpc.request('tools/list', {})).result.tools;
	assert.deepEqual(compact.map(t => t.name).sort(), ['discover', 'lookup', 'preflight']);
	const expected = JSON.parse(await readFile(new URL('./discovery-api.json', import.meta.url), 'utf8'));
	assert.deepEqual(publicSurface(compact), expected);
	const full = await connect(null, 'http');
	t.after(() => full.close());
	const listed = (await full.request('tools/list', {})).result.tools;
	assert.equal(listed.length, 60);
	assert.ok(JSON.stringify(compact).length < JSON.stringify(listed).length / 4);
	for (const name of ['email', 'domain', 'dns', 'mx', 'country']) {
		const detail = body(await rpc.call('discover', { operation: name }));
		const actual = publicSurface([{ name, inputSchema: detail.operations[0].inputSchema }]);
		const original = publicSurface([{ name, inputSchema: listed.find(t => t.name === name).inputSchema }]);
		assert.deepEqual(actual, original);
	}
	assert.equal(calls.length, 0);
});

test('discovery is local, versioned and separates static policy from account facts', async (t) => {
	const { rpc, calls } = await setup(t, { key: null });
	const raw = await rpc.call('discover', { operation: 'email' });
	const data = body(raw);
	assert.deepEqual(raw.result.structuredContent, data);
	assert.equal(data.schema_version, '1.0.0');
	assert.equal(data.api_version, '2.0.0');
	assert.equal(data.effective_access, 'not_evaluated');
	assert.equal(data.pricing, 'not_quoted');
	assert.deepEqual(data.policy_operations, ['card', 'country', 'dns', 'domain', 'email', 'mx']);
	const source = JSON.parse(await readFile(new URL('../src/agent-catalog.json', import.meta.url), 'utf8'));
	assert.deepEqual(data.operations[0].policy, source.operations.email);
	assert.equal(data.operations[0].policy_available, true);
	assert.equal(body(await rpc.call('lookup', { operation: 'email', arguments: { email: 'a@example.com' } })).code, 'invalid_api_key');
	assert.equal(calls.length, 0);
});

test('discovery searches, pages and explicitly identifies unreviewed policy', async (t) => {
	const { rpc, calls } = await setup(t);
	const search = body(await rpc.call('discover', { query: 'mailbox' }));
	assert.ok(search.operations.some(t => t.name === 'email'));
	assert.ok(search.operations.every(t => !('inputSchema' in t) && !('policy' in t)));
	assert.equal(body(await rpc.call('discover', { query: 'zxqvnonexistent' })).total_matches, 0);
	assert.equal(body(await rpc.call('discover', { query: '!!!' })).total_matches, 0);
	const names = [];
	let offset = 0;
	do {
		const page = body(await rpc.call('discover', { limit: 7, offset }));
		names.push(...page.operations.map(t => t.name));
		offset = page.next_offset;
	} while (offset !== null);
	assert.equal(new Set(names).size, 58);
	assert.equal(names.length, 58);
	assert.ok(!names.some(n => ['ip_self', 'swift', 'routing', 'litigator', 'rnd', 'screenshot', 'url', 'discover', 'lookup'].includes(n)));
	const unreviewed = body(await rpc.call('discover', { operation: 'time' })).operations[0];
	assert.equal(unreviewed.policy_available, false);
	assert.equal(unreviewed.policy, null);
	assert.ok(unreviewed.inputSchema);
	assert.equal(calls.length, 0);
});

test('Card remains discoverable by product name and BIN/IIN terms', async (t) => {
	const { rpc, calls } = await setup(t, { key: null });
	for (const query of ['card', 'BIN', 'IIN']) {
		const data = body(await rpc.call('discover', { query }));
		assert.ok(data.operations.some(operation => operation.name === 'card'), query);
		assert.ok(!data.operations.some(operation => operation.name === 'bin'), query);
	}
	const detail = body(await rpc.call('discover', { operation: 'card' })).operations[0];
	assert.deepEqual(detail.inputSchema.required, ['bin']);
	assert.equal(detail.inputSchema.properties.bin.type, 'string');
	assert.equal(calls.length, 0);
});

test('invalid discovery and compact arguments never call HTTP', async (t) => {
	const { rpc, calls } = await setup(t);
	for (const args of [{ limit: 21 }, { offset: -1 }, { query: '' }, { query: 'a'.repeat(257) }, { operation: 'email', query: 'email' }]) {
		assert.equal((await rpc.call('discover', args)).result.isError, true);
	}
	for (const operation of ['swift', 'routing', 'ip_self', 'constructor', 'discover', 'https://example.com']) {
		assert.equal(body(await rpc.call('discover', { operation })).code, 'invalid_request');
		assert.equal(body(await rpc.call('lookup', { operation, arguments: {} })).code, 'invalid_request');
	}
	for (const [operation, args] of [
		['email', {}], ['dns', { domain: 'example.com', type: 'ANY' }], ['country', { code: 3 }],
		['time', { lat: 0 }], ['time', { timezone: 'UTC', lat: 0, lon: 0 }],
		['timezone', { lat: 0, lon: 0, to: 'UTC' }], ['date', { format: 'mdy' }],
	]) {
		assert.equal(body(await rpc.call('lookup', { operation, arguments: args })).code, 'invalid_request');
	}
	assert.equal(calls.length, 0);
});

test('compact lookup preserves every existing route, query, payload and API pin', async (t) => {
	const { rpc, calls } = await setup(t, { transport: 'stdio' });
	for (const [name, args, pathname, query = {}] of cases) {
		const result = await rpc.call('lookup', { operation: name, arguments: args });
		assert.deepEqual(body(result), { future: null, zero: 0, negative: false, empty: [], deep: {} });
		const call = calls.at(-1);
		assert.equal(call.url.pathname, pathname, name);
		assert.deepEqual(Object.fromEntries(call.url.searchParams), query, name);
		assert.equal(new Headers(call.init.headers).get('parse-version'), '2.0.0');
		assert.equal(new Headers(call.init.headers).get('x-api-key'), 'test_key');
		assert.equal(call.init.redirect, 'manual');
	}
	assert.equal(calls.length, cases.length);
	await rpc.call('lookup', { operation: 'country', arguments: { code: 'DE', lang: 'fr' } });
	assert.equal(calls.at(-1).url.searchParams.get('lang'), 'fr');
});

test('compact lookup preserves API errors and retry economics', async (t) => {
	const error = { code: 'service_unavailable', message: 'Try later', docs: null, request_id: 'req_fixture' };
	const { rpc, calls } = await setup(t, { fetch: () => response(error, 503) });
	const paid = await rpc.call('lookup', { operation: 'email', arguments: { email: 'a@example.com', deep: true } });
	assert.equal(paid.result.isError, true);
	assert.deepEqual(body(paid), { ...error, retry_after: '0' });
	assert.equal(calls.length, 1);
	const ordinary = await rpc.call('lookup', { operation: 'dns', arguments: { domain: 'example.com' } });
	assert.deepEqual(body(ordinary), { ...error, retry_after: '0' });
	assert.equal(calls.length, 4);
});

test('compact cancellation aborts the same SDK request without retry', async (t) => {
	let started, aborted;
	const fetching = new Promise(resolve => { started = resolve; });
	const cancelled = new Promise(resolve => { aborted = resolve; });
	const { rpc, calls } = await setup(t, { fetch: ({ init }) => new Promise((_, reject) => {
		init.signal.addEventListener('abort', () => { aborted(); reject(init.signal.reason); }, { once: true });
		started();
	}) });
	const pending = rpc.startRequest('tools/call', { name: 'lookup', arguments: { operation: 'country', arguments: { code: 'US' } } });
	await fetching;
	await rpc.notify('notifications/cancelled', { requestId: pending.id, reason: 'Stopped' });
	await cancelled;
	assert.equal(calls.length, 1);
	assert.equal(calls[0].init.signal.aborted, true);
	await rpc.close();
	await pending.response;
});
