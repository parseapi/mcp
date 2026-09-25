import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { connect, body, publicSurface } from './helpers.mjs';

const id = 'co_xw3f22es6cjq';
const profile = { id, name: 'Cloudflare, Inc.', country: 'US', website: null, listings: [], address: null };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Retry-After': '0' } });
async function setup(t, { mode = 'full', transport = 'http', fetch } = {}) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (input, init) => { const call = { url: new URL(String(input)), init }; calls.push(call); return fetch ? fetch(call) : response(profile); });
	const rpc = await connect('fixture', transport, { mode }); t.after(() => rpc.close()); return { rpc, calls };
}

test('directory operations are discoverable without language or invented policies', async t => {
	const { rpc, calls } = await setup(t, { mode: 'compact' });
	const rows = [];
	for (const operation of ['company_id', 'company_search', 'company_coverage']) {
		const item = body(await rpc.call('discover', { operation })).operations[0];
		assert.equal(item.name, operation); assert.equal(item.policy_available, false); assert.equal(item.policy, null); assert.equal(item.inputSchema.properties.lang, undefined);
		rows.push({ name: item.name, inputSchema: item.inputSchema });
	}
	assert.deepEqual(publicSurface(rows).map(({ name, inputSchema }) => ({ name, inputSchema })), JSON.parse(await readFile(new URL('./company-discovery-api.json', import.meta.url), 'utf8')));
	assert.equal(calls.length, 0);
});

test('full and compact directory search reject invalid selectors and discovery filters before HTTP', async t => {
	for (const mode of ['full', 'compact']) {
		const { rpc, calls } = await setup(t, { mode });
		for (const args of [{}, { q: 'Acme' }, { query: 'Acme', domain: 'acme.com' }, { ticker: 'NET', identifier: '001' }, { query: '' }, { country: '' }, { country: ' ' }, { country: 'USA' }, { industry: '0700' }, { industry_type: 'sic' }, { country: 'US', industry: '0700' }, { country: 'US', industry_type: 'sic' }, { industry: '0700', industry_type: 'naics' }, { industry: '700', industry_type: 'sic' }, { industry: '０７００', industry_type: 'sic' }, { industry: 700, industry_type: 'sic' }, { query: 'A', domain: 'a.com', country: 'US' }]) {
			const result = mode === 'full' ? await rpc.call('company_search', args) : await rpc.call('lookup', { operation: 'company_search', arguments: args });
			assert.equal(result.result.isError, true);
		}
		assert.equal(calls.length, 0);
	}
});

test('directory ID and search preserve optional deep, future codes, unknown fields and empty results', async t => {
	let value = profile;
	const { rpc, calls } = await setup(t, { fetch: () => response(value) });
	const deep = { description: null, logo: null, socials: [], founded: { value: '1998', precision: 'future-precision' }, sources: [{ type: 'future-source', url: 'https://example.com/', fields: ['future-field'], observed_at: '2026-09-23T00:00:00Z', updated_at: null }], future: true };
	for (const extra of [{}, { deep: {} }, { deep: { legal_name: 'Prior legal name' } }, { deep: { description: null, socials: null, founded: null, sources: null } }, { deep, future: 'new' }]) {
		value = { ...profile, ...extra }; assert.deepEqual(body(await rpc.call('company_id', { id, deep: true })), value);
		value = { companies: [{ ...value, match: { field: 'future-field', value: null, future: true } }], next: 'opaque', future: [] };
		assert.deepEqual(body(await rpc.call('company_search', { query: 'Cloudflare', deep: true })), value);
	}
	value = { companies: [], next: null }; assert.deepEqual(body(await rpc.call('company_search', { domain: 'unknown.example.com' })), value);
	await rpc.call('company_id', { id, lang: 'fr' }); await rpc.call('company_coverage', { lang: 'fr' });
	assert.equal(calls.at(-2).url.searchParams.has('lang'), false); assert.equal(calls.at(-1).url.search, '');
});

test('directory API errors remain structured and ordinary transient failures retain retries', async t => {
	let status = 400;
	const error = { code: 'invalid_request', message: 'Invalid or expired cursor', docs: null, request_id: 'req_directory' };
	const { rpc, calls } = await setup(t, { fetch: () => response(error, status) });
	let result = await rpc.call('company_search', { query: 'Acme', cursor: 'stale' }); assert.equal(result.result.isError, true); assert.deepEqual(body(result), { ...error, retry_after: '0' }); assert.equal(calls.length, 1);
	status = 404; result = await rpc.call('company_id', { id }); assert.equal(result.result.isError, true); assert.deepEqual(body(result), { ...error, retry_after: '0' }); assert.equal(calls.length, 2);
	status = 503; await rpc.call('company_coverage', {}); assert.equal(calls.length, 5);
});

test('directory cancellation aborts the packed SDK request without retrying', async t => {
	let started, aborted; const fetching = new Promise(resolve => { started = resolve; }), cancelled = new Promise(resolve => { aborted = resolve; });
	const { rpc, calls } = await setup(t, { fetch: ({ init }) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => { aborted(); reject(init.signal.reason); }, { once: true }); started(); }) });
	const pending = rpc.startRequest('tools/call', { name: 'company_search', arguments: { identifier: '0000081061', authority: 'SEC' } });
	await fetching; await rpc.notify('notifications/cancelled', { requestId: pending.id, reason: 'Stopped directory search' }); await cancelled;
	assert.equal(calls.length, 1); assert.equal(calls[0].init.signal.aborted, true); await rpc.close(); await pending.response;
});


test('full and compact Company tools preserve dated employees without inferring missing counts', async t => {
	for (const mode of ['full', 'compact']) await t.test(mode, async t => {
		let value;
		const { rpc, calls } = await setup(t, { mode, fetch: () => response(value) });
		const invoke = (name, args) => mode === 'full' ? rpc.call(name, args) : rpc.call('lookup', { operation: name, arguments: args });
		for (const deep of [
			{}, { employees: null },
			{ employees: { count: 0, as_of: '2025-12-31', scope: 'legal_entity', method: 'reported', approximate: false } },
			{ employees: { count: 12500, as_of: '2026-06-30', scope: 'consolidated_group', method: 'reported', approximate: true } },
			{ employees: { count: 7, as_of: '2026-01-15', scope: 'future_scope', method: 'future_method', approximate: false, future: null } },
		]) {
			value = { ...profile, deep };
			assert.deepEqual(body(await invoke('company_id', { id, deep: true })), value);
			value = { companies: [{ ...value, match: { field: 'name', value: profile.name } }], next: null };
			assert.deepEqual(body(await invoke('company_search', { query: profile.name, deep: true })), value);
		}
		assert.equal(calls.length, 10);
	});
});


test('country and exact SIC discovery work in full and compact mode with bound cursor inputs', async t => {
	for (const mode of ['full', 'compact']) await t.test(mode, async t => {
		const page = { companies: [{ ...profile, match: { field: 'filters', value: null } }], next: 'opaque+/=' };
		const { rpc, calls } = await setup(t, { mode, fetch: () => response(page) });
		const operations = [
			{ country: 'US' }, { industry: '0700', industry_type: 'sic' },
			{ country: 'US', industry: '0700', industry_type: 'sic', limit: 2, cursor: page.next, deep: true },
			{ query: 'Example', country: 'US', industry: '0700', industry_type: 'sic', deep: false },
		];
		for (const args of operations) {
			const result = mode === 'full' ? await rpc.call('company_search', args) : await rpc.call('lookup', { operation: 'company_search', arguments: args });
			assert.deepEqual(body(result), page);
		}
		assert.deepEqual(calls.map(call => Object.fromEntries(call.url.searchParams)), [
			{ country: 'US' }, { industry: '0700', industry_type: 'sic' },
			{ country: 'US', industry: '0700', industry_type: 'sic', limit: '2', cursor: 'opaque+/=', deep: 'true' },
			{ q: 'Example', country: 'US', industry: '0700', industry_type: 'sic' },
		]);
	});
});


test('full and compact Company tools preserve registration facts and source attribution', async t => {
 for (const mode of ['full', 'compact']) await t.test(mode, async t => {
  let value; const { rpc, calls } = await setup(t, { mode, fetch: () => response(value) });
  const invoke = (name, args) => mode === 'full' ? rpc.call(name, args) : rpc.call('lookup', { operation: name, arguments: args });
  const registration = {"authority":"RA000599","number":"0001234567","jurisdiction":{"country":"US","state":"CO"},"role":"domestic","legal_form":{"code":"DNC","name":"Domestic Non-profit Corporation"},"status":"Good Standing","formation_date":"2004-02-29","address":{"kind":"principal","line1":"12 Main St.","line2":"Suite 2","city":"Example","state":"CO","postal":"00123-0001","country_raw":"US"},"future":"retained"};
  for (const deep of [{}, { registrations: null }, { registrations: [] }, { registrations: [registration], sources: [{"type":"business_register","url":"https://data.colorado.gov/Business/Business-Entities-in-Colorado/4ykn-tg5h","fields":["registrations"],"observed_at":"2026-09-23T15:00:52.763514Z","updated_at":null}] }, { registrations: [{ ...registration, role: 'future_role', formation_date: null, address: null }] }]) {
   value = { ...profile, deep }; assert.deepEqual(body(await invoke('company_id', { id, deep: true })), value);
   value = { companies: [{ ...value, match: { field: 'identifier', value: registration.number } }], next: null };
   assert.deepEqual(body(await invoke('company_search', { identifier: registration.number, authority: registration.authority, deep: true })), value);
  }
  assert.equal(calls.length, 10);
 });
});


test('registration discovery validates independent scope and exact source strings before HTTP', async t => {
 for (const mode of ['full', 'compact']) {
  const { rpc, calls } = await setup(t, { mode });
  const invoke = args => mode === 'full' ? rpc.call('company_search', args) : rpc.call('lookup', { operation: 'company_search', arguments: args });
  const invalid = [
   { registration_form: 'DPC' }, { registration_status: 'Good Standing' },
   { authority: 'RA000599', registration_form: 'DPC' },
   ...['', ' ', ' RA000599', 'RA000599 ', 'RA00599', 'RA0005999', 'ＲＡ000599', 'SEC'].map(registration_authority => ({ registration_authority })),
   { registration_authority: 599 }, { registration_authority: ['RA000599'] },
   { registration_authority: 'RA000599', query: 'Acme', domain: 'acme.com' },
   { registration_authority: 'RA000599', country: '' },
   { registration_authority: 'RA000599', industry: '0700' },
  ];
  for (const name of ['registration_form', 'registration_status']) for (const value of ['', ' ', '\t', '\n', '\u0000', '\u007f', '\u0085', 'x'.repeat(201), '😀'.repeat(101), null, 1, ['DPC']]) {
   invalid.push({ registration_authority: 'RA000599', [name]: value });
  }
  for (const args of invalid) assert.equal((await invoke(args)).result.isError, true, JSON.stringify(args));
  assert.equal(calls.length, 0);
 }
});

test('full and compact registration search normalize only authority and retain other exact filters', async t => {
 for (const mode of ['full', 'compact']) {
  const { rpc, calls } = await setup(t, { mode, fetch: () => response({ companies: [], next: null }) });
  const invoke = args => mode === 'full' ? rpc.call('company_search', args) : rpc.call('lookup', { operation: 'company_search', arguments: args });
  const cases = [
   [{ registration_authority: 'ra000599' }, { registration_authority: 'RA000599' }],
   [{ country: 'US', industry: '0700', industry_type: 'sic', registration_authority: 'RA000599', registration_form: 'DPC', registration_status: ' Good Standing ', limit: 2, cursor: 'opaque+/=', deep: true }, { country: 'US', industry: '0700', industry_type: 'sic', registration_authority: 'RA000599', registration_form: 'DPC', registration_status: ' Good Standing ', limit: '2', cursor: 'opaque+/=', deep: 'true' }],
   [{ identifier: '00001', authority: 'SEC', registration_authority: 'RA000599', registration_form: ' FUTURE/Form ', registration_status: 'future+& status', deep: false }, { identifier: '00001', authority: 'SEC', registration_authority: 'RA000599', registration_form: ' FUTURE/Form ', registration_status: 'future+& status' }],
  ];
  for (const [args, expected] of cases) {
   const result = await invoke(args); assert.notEqual(result.result.isError, true); assert.deepEqual(body(result), { companies: [], next: null });
   assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams), expected);
  }
  assert.equal(calls.length, cases.length);
 }
});
