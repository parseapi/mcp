import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { connect, body, publicSurface } from './helpers.mjs';
import { cases } from './cases.mjs';

const response = (data, status = 200) => new Response(JSON.stringify(data), {
	status, headers: { 'content-type': 'application/json', 'retry-after': '0' },
});

async function setup(t, { key = 'test_key', transport = 'stdio', fetch } = {}) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (input, init) => {
		const call = { url: new URL(String(input)), init };
		calls.push(call);
		return fetch ? fetch(call) : response({ future: { nullable: null }, deep: {} });
	});
	const rpc = await connect(key, transport);
	t.after(() => rpc.close());
	return { rpc, calls };
}

test('tool names and argument schemas match the reviewed public baseline', async (t) => {
	const { rpc, calls } = await setup(t, { key: null });
	const result = await rpc.request('tools/list', {});
	const tools = result.result.tools;
	const expected = JSON.parse(await readFile(new URL('./public-api.json', import.meta.url), 'utf8'));
	assert.deepEqual(publicSurface(tools), expected);
	assert.equal(tools.length, 51);
	assert.deepEqual([...new Set(cases.map(([name]) => name))].sort(), tools.map(({ name }) => name).sort());
	assert.equal(calls.length, 0);
});

test('hosted scope excludes only ip_self; listing and keyless calls stay offline', async (t) => {
	const { rpc, calls } = await setup(t, { key: null, transport: 'http' });
	const { result } = await rpc.request('tools/list', {});
	assert.equal(result.tools.length, 50);
	assert.equal(result.tools.some(({ name }) => name === 'ip_self' || name === 'company_search'), false);
	const called = await rpc.call('company', { number: '552100554', country: 'FR' });
	assert.equal(called.result.isError, true);
	assert.equal(body(called).code, 'invalid_api_key');
	assert.equal(calls.length, 0);
});

for (const [name, args, pathname, query = {}] of cases) {
	test(`${name} ${pathname}: route, all options, response and request signal`, async (t) => {
		const { rpc, calls } = await setup(t);
		const called = await rpc.call(name, args);
		assert.equal(called.result?.isError, undefined, JSON.stringify(called));
		assert.deepEqual(body(called), { future: { nullable: null }, deep: {} });
		assert.equal(calls.length, 1);
		const { url, init } = calls[0];
		assert.equal(url.pathname, pathname);
		assert.deepEqual(Object.fromEntries(url.searchParams), query);
		assert.equal(init.redirect, 'manual');
		assert.ok(init.signal instanceof AbortSignal);
		const headers = new Headers(init.headers);
		assert.equal(headers.get('x-api-key'), 'test_key');
		if (name === 'useragent') assert.equal(headers.get('user-agent'), args.ua);
	});
}

test('search requires query and rejects the retired q input before any HTTP call', async (t) => {
	const { rpc, calls } = await setup(t);
	for (const name of ['city_search', 'address_search', 'tariff_search', 'emoji_search']) {
		const called = await rpc.call(name, { q: 'coffee' });
		assert.equal(called.result?.isError, true, JSON.stringify(called));
	}
	assert.equal(calls.length, 0);
});

test('ambiguous timezone input and ignored date options are validation errors', async (t) => {
	const { rpc, calls } = await setup(t);
	for (const args of [{}, { lat: 0 }, { lon: 0 }, { timezone: '' },
		{ timezone: 'UTC', lat: 0, lon: 0 }, { lat: 0, lon: 0, to: 'UTC' }]) {
		const called = await rpc.call('timezone', args);
		assert.equal(called.result?.isError, true, JSON.stringify(called));
	}
	for (const args of [{ date: '' }, { format: 'mdy' }]) {
		const called = await rpc.call('date', args);
		assert.equal(called.result?.isError, true, JSON.stringify(called));
	}
	assert.equal(calls.length, 0);
});

test('API errors preserve machine-readable details', async (t) => {
	const error = { code: 'not_found', message: 'No match', docs: 'https://parseapi.com/docs#not_found', request_id: 'req_test' };
	const { rpc, calls } = await setup(t, { fetch: () => response(error, 404) });
	const called = await rpc.call('city', { name: 'missing' });
	assert.equal(called.result.isError, true);
	assert.deepEqual(body(called), error);
	assert.equal(calls.length, 1);
});

test('metered core and deep calls inherit zero retries from the SDK', async (t) => {
	const { rpc, calls } = await setup(t, { fetch: () => response({ code: 'unavailable', message: 'Try later' }, 503) });
	for (const [name, args] of [
		['carrier', { number: '555-0100' }], ['caller', { number: '555-0100' }], ['hlr', { number: '555-0100' }],
		['email', { email: 'a@example.com', deep: true }], ['vat', { number: 'DE123', deep: true }],
		['address', { address: '10 Main St', deep: true }],
	]) {
		const count = calls.length;
		const called = await rpc.call(name, args);
		assert.equal(called.result.isError, true);
		assert.equal(calls.length - count, 1, name);
	}
});

test('ordinary lookups still inherit two retries', async (t) => {
	const { rpc, calls } = await setup(t, { fetch: () => response({ code: 'unavailable', message: 'Try later' }, 503) });
	assert.equal((await rpc.call('country', { code: 'US' })).result.isError, true);
	assert.equal(calls.length, 3);
});

test('MCP cancellation aborts the SDK request without retrying', async (t) => {
	let started;
	const fetching = new Promise((resolve) => { started = resolve; });
	let aborted;
	const cancellation = new Promise((resolve) => { aborted = resolve; });
	const { rpc, calls } = await setup(t, { fetch: ({ init }) => new Promise((_, reject) => {
		init.signal.addEventListener('abort', () => {
			aborted();
			reject(init.signal.reason);
		}, { once: true });
		started();
	}) });
	const request = rpc.startRequest('tools/call', { name: 'country', arguments: { code: 'US' } });
	await fetching;
	await rpc.notify('notifications/cancelled', { requestId: request.id, reason: 'Caller stopped' });
	await cancellation;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].init.signal.aborted, true);
	// The protocol may suppress the response to a cancelled request.
	await rpc.close();
	await request.response;
});
