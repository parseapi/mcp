import assert from 'node:assert/strict';
import { test } from 'node:test';
import { body, connect } from './helpers.mjs';

const id = 'job_23456789abcdef';
const workflow = ['bulk_upload', 'bulk_preview', 'bulk_start', 'bulk_status', 'bulk_result'];
const job = { job: { id, status: 'quoted', sample: { deliverable: null, count: 0, included: false, empty: [], future: 'kept' } }, poll_after_seconds: null, quote: { id: 'quote_fixture', currency: 'USD', cost_cents: 0, expires_at: '2026-10-23T20:00:00Z' } };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

for (const mode of ['full', 'compact']) for (const transport of ['stdio', 'http']) test(`${transport}/${mode} Bulk tools keep file transfer separate and preserve unknown results`, async t => {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, init) => {
		calls.push({ url: String(url), init });
		if (String(url).endsWith('/api/agent/bulk')) return json({ id, rail: 'plan', upload_url: 'https://files.example.test/input?signature=opaque', upload_headers: { 'content-type': 'text/csv' }, upload_method: 'PUT', upload_expires_at: '2026-10-23T20:00:00Z' });
		if (String(url).endsWith('/result')) return json({ id, download_url: 'https://parseapi.com/api/agent/bulk/download?cap=opaque', expires_at: '2026-10-23T20:00:00Z' });
		return json(job);
	});
	const rpc = await connect('private_fixture_key', transport, { mode });
	t.after(() => rpc.close());
	const tools = (await rpc.request('tools/list', {})).result.tools;
	assert.deepEqual(tools.filter(tool => tool.name.startsWith('bulk_')).map(tool => tool.name).sort(), [...workflow].sort());
	assert.equal(tools.find(tool => tool.name === 'bulk_upload').annotations.idempotentHint, false);
	assert.equal(tools.find(tool => tool.name === 'bulk_start').annotations.readOnlyHint, false);
	assert.equal(tools.find(tool => tool.name === 'bulk_start').annotations.idempotentHint, true);
	const upload = body(await rpc.call('bulk_upload', { filename: 'customers.csv', file_size: 42, country: 'US', lang: 'fr' }));
	assert.equal(upload.id, id);
	assert.equal(calls.length, 1);
	assert.deepEqual(JSON.parse(calls[0].init.body), { filename: 'customers.csv', file_size: 42, country: 'US', lang: 'fr' });
	assert.equal(body(await rpc.call('bulk_preview', { id, checks: ['email', 'ip'] })).job.sample.deliverable, null);
	assert.deepEqual(JSON.parse(calls[1].init.body), { checks: ['email', 'ip'] });
	assert.deepEqual(body(await rpc.call('bulk_start', { id, quote_id: 'quote_fixture', max_cost_cents: 0 })), job);
	assert.deepEqual(JSON.parse(calls[2].init.body), { quote_id: 'quote_fixture', max_cost_cents: 0 });
	assert.deepEqual(body(await rpc.call('bulk_status', { id })), job);
	const result = await rpc.call('bulk_result', { id });
	assert.equal(body(result).download_url, 'https://parseapi.com/api/agent/bulk/download?cap=opaque');
	assert.ok(!JSON.stringify(result).includes('private_fixture_key'));
	assert.equal(calls.length, 5);
	for (const call of calls) {
		assert.equal(new Headers(call.init.headers).get('x-api-key'), 'private_fixture_key');
		assert.equal(new Headers(call.init.headers).get('parse-version'), '2.0.0');
		assert.equal(call.init.redirect, 'manual');
		assert.ok(call.url.startsWith('https://parseapi.com/api/agent/bulk'));
	}
});

test('Bulk tools reject file contents, arbitrary sources, paths and retired checks before HTTP', async t => {
	t.mock.method(globalThis, 'fetch', () => assert.fail('invalid arguments must not dispatch'));
	const rpc = await connect('key');
	t.after(() => rpc.close());
	for (const extra of [{ file_path: '/private/secret.csv' }, { url: 'https://evil.test/file.csv' }, { content: 'email\nperson@example.com' }, { base64: 'c2VjcmV0' }]) assert.equal((await rpc.call('bulk_upload', { filename: 'x.csv', file_size: 5, ...extra })).result.isError, true);
	for (const checks of [[], ['npi'], ['bank'], ['vat'], ['litigator'], ['email', 'email']]) assert.equal((await rpc.call('bulk_preview', { id, checks })).result.isError, true);
	assert.equal((await rpc.call('bulk_status', { id: '../other-account' })).result.isError, true);
	assert.equal((await rpc.call('bulk_start', { id, quote_id: 'quote', max_cost_cents: -1 })).result.isError, true);
});

test('keyless Bulk tools list normally and never create work', async t => {
	t.mock.method(globalThis, 'fetch', () => assert.fail('keyless must not dispatch'));
	const rpc = await connect(null, 'stdio');
	t.after(() => rpc.close());
	assert.equal(body(await rpc.call('bulk_upload', { filename: 'x.csv', file_size: 10 })).code, 'invalid_api_key');
	assert.equal(body(await rpc.call('bulk_status', { id })).code, 'invalid_api_key');
});

test('Bulk preserves typed server errors and does not retry uncertain mutations', async t => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => { calls++; return json({ code: 'quote_changed', message: 'Preview the updated quote.', request_id: 'req_fixture' }, 409, { 'retry-after': '5' }); });
	const rpc = await connect('private_fixture_key');
	t.after(() => rpc.close());
	assert.deepEqual(body(await rpc.call('bulk_start', { id, quote_id: 'quote', max_cost_cents: 5 })), { code: 'quote_changed', message: 'Preview the updated quote.', request_id: 'req_fixture', docs: null, retry_after: '5' });
	assert.equal(calls, 1);
});

test('Bulk network errors do not reveal credentials or internal fetch details', async t => {
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('request secret private_fixture_key internal token'); });
	const rpc = await connect('private_fixture_key');
	t.after(() => rpc.close());
	const result = await rpc.call('bulk_status', { id });
	assert.equal(body(result).code, 'network_error');
	assert.ok(!JSON.stringify(result).includes('private_fixture_key'));
});

test('Bulk returns paid handoffs as account metadata without a second payment request', async t => {
	let calls = 0;
	const handoff = { job: job.job, requires_payment: true, code: 'payment_required', confirmation_url: `https://parseapi.com/bulk/${id}` };
	t.mock.method(globalThis, 'fetch', async () => { calls++; return json(handoff); });
	const rpc = await connect('private_fixture_key');
	t.after(() => rpc.close());
	assert.deepEqual(body(await rpc.call('bulk_start', { id, quote_id: 'quote_fixture', max_cost_cents: 500 })), handoff);
	assert.equal(calls, 1);
});
