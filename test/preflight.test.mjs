import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';

const response = (data, status = 200) => new Response(JSON.stringify(data), {
	status, headers: { 'content-type': 'application/json', 'retry-after': '0' },
});
const task = { operations: [{ operation: 'email', count: 100, deep: true }, { operation: 'country', count: 1 }], budget_usd: '2.50' };

async function setup(t, { mode = 'compact', transport = 'http', key = 'fixture', fetch } = {}) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, init) => {
		calls.push({ url: new URL(String(url)), init });
		return fetch ? fetch(calls.at(-1)) : response({ estimate_only: true, permitted: false, cost: { maximum_usd: null }, future: 0 });
	});
	const rpc = await connect(key, transport, { mode });
	t.after(() => rpc.close());
	return { rpc, calls };
}

for (const mode of ['compact', 'full']) for (const transport of ['stdio', 'http']) {
	test(`${mode} ${transport} preflight uses the existing SDK POST, credentials and pinned contract`, async t => {
		const { rpc, calls } = await setup(t, { mode, transport });
		const result = await rpc.call('preflight', task);
		assert.deepEqual(body(result), { estimate_only: true, permitted: false, cost: { maximum_usd: null }, future: 0 });
		assert.deepEqual(result.result.structuredContent, body(result));
		assert.equal(calls.length, 1);
		const { url, init } = calls[0];
		assert.equal(url.pathname, '/preflight');
		assert.equal(url.search, '');
		assert.equal(init.method, 'POST');
		assert.equal(init.redirect, 'manual');
		assert.deepEqual(JSON.parse(init.body), task);
		const headers = new Headers(init.headers);
		assert.equal(headers.get('X-API-Key'), 'fixture');
		assert.equal(headers.get('Parse-Version'), '2.0.0');
		assert.equal(headers.get('Content-Type'), 'application/json');
		const tools = (await rpc.request('tools/list', {})).result.tools;
		const preflight = tools.find(tool => tool.name === 'preflight');
		assert.equal(preflight.annotations.readOnlyHint, true);
		assert.equal(preflight.annotations.idempotentHint, true);
		if (mode === 'compact') assert.equal(body(await rpc.call('lookup', { operation: 'preflight', arguments: task })).code, 'invalid_request');
	});
}

test('preflight rejects unsupported operations, input payloads, excess counts and imprecise budgets locally', async t => {
	const { rpc, calls } = await setup(t);
	for (const invalid of [
		{}, { operations: [] }, { operations: [{ operation: 'url', count: 1 }] },
		{ operations: [{ operation: 'email', count: 1, email: 'private@example.com' }] },
		{ operations: [{ operation: 'email', count: 1 }], inputs: ['private@example.com'] },
		{ operations: [{ operation: 'email', count: 1, deep: 'true' }] },
		...[0, -1, 1.5, 100001].map(count => ({ operations: [{ operation: 'email', count }] })),
		{ operations: Array.from({ length: 21 }, () => ({ operation: 'country', count: 1 })) },
		{ operations: [{ operation: 'email', count: 60000 }, { operation: 'dns', count: 40001 }] },
		...[2.50, '2.501', '-1', '1e2', '01.00', '1000000000000'].map(budget_usd => ({ ...task, budget_usd })),
	]) assert.equal((await rpc.call('preflight', invalid)).result.isError, true, JSON.stringify(invalid));
	assert.equal(calls.length, 0);
	await rpc.call('preflight', { operations: [{ operation: 'dns', count: 100000 }], budget_usd: '0' });
	assert.equal(calls.length, 1);
});

for (const transport of ['stdio', 'http']) test(`${transport} keyless preflight stays offline`, async t => {
	const { rpc, calls } = await setup(t, { transport, key: null });
	const result = await rpc.call('preflight', task);
	assert.equal(result.result.isError, true);
	assert.equal(body(result).code, 'invalid_api_key');
	assert.equal(calls.length, 0);
});

test('preflight preserves API errors and read-only retry behavior', async t => {
	const error = { code: 'service_unavailable', message: 'Unavailable', docs: null, request_id: 'req_fixture' };
	const { rpc, calls } = await setup(t, { fetch: () => response(error, 503) });
	const result = await rpc.call('preflight', task);
	assert.equal(result.result.isError, true);
	assert.deepEqual(body(result), { ...error, retry_after: '0' });
	assert.equal(calls.length, 3);
	assert.ok(calls.every(call => call.init.body === calls[0].init.body));
});

test('cancelling preflight aborts the SDK POST without retries', async t => {
	let started, aborted;
	const fetching = new Promise(resolve => { started = resolve; });
	const cancelled = new Promise(resolve => { aborted = resolve; });
	const { rpc, calls } = await setup(t, { fetch: ({ init }) => new Promise((_, reject) => {
		init.signal.addEventListener('abort', () => { aborted(); reject(init.signal.reason); }, { once: true });
		started();
	}) });
	const pending = rpc.startRequest('tools/call', { name: 'preflight', arguments: task });
	await fetching;
	await rpc.notify('notifications/cancelled', { requestId: pending.id, reason: 'Stopped' });
	await cancelled;
	assert.equal(calls.length, 1);
	assert.equal(calls[0].init.signal.aborted, true);
	await rpc.close();
	await pending.response;
});
