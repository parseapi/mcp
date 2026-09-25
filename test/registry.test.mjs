import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { connect, body, publicSurface } from './helpers.mjs';
import { cases } from './cases.mjs';

const response = (data, status = 200) => new Response(JSON.stringify(data), {
	status, headers: { 'content-type': 'application/json', 'retry-after': '0' },
});

test('Bank checks, issues and raw input survive both transports', async (t) => {
	const fixture = JSON.parse(await readFile(new URL('./bank-fixtures.json', import.meta.url), 'utf8'));
	let record;
	const { rpc, calls } = await setup(t, { fetch: () => response(record) });
	const hosted = await connect('test_key', 'http');
	t.after(() => hosted.close());
	for (const target of [rpc, hosted]) {
		for (const payload of fixture.records) {
			record = payload;
			for (const iban of fixture.inputs) {
				assert.deepEqual(body(await target.call('bank', { iban, deep: true })), payload);
				assert.equal(calls.at(-1).url.pathname + calls.at(-1).url.search, '/bank');
				assert.equal(calls.at(-1).init.method, 'POST');
				assert.deepEqual(JSON.parse(calls.at(-1).init.body), { iban, deep: true });
			}
		}
	}
});

test('Australian Postal choices preserve core ambiguity and source notice on both transports', async (t) => {
	let record;
	const { rpc } = await setup(t, { fetch: () => response(record) });
	const choice = { city: 'SYDNEY', state: 'NSW', state_name: 'New South Wales', future: true };
	for (const localities of [undefined, null, [], [choice], [choice, { city: 'HAYMARKET', state: 'NSW', state_name: 'New South Wales' }]]) {
		record = { postal: '2000', country: 'AU', city: null, ...(localities === undefined ? {} : { localities }) };
		const result = await rpc.call('postal', { code: '2000', country: 'AU' });
		assert.deepEqual(body(result), record);
		assert.equal(result.result.content.length, 2);
		assert.match(result.result.content[1].text, /G-NAF.*Geoscape Australia/);
		assert.match(result.result.content[1].text, /https:\/\/parseapi\.com\/legal\/attribution#postal-au/);
	}
	const hosted = await connect('test_key', 'http');
	t.after(() => hosted.close());
	for (const target of [rpc, hosted]) {
		for (const [name, args, payload] of [
			['postal', { code: '3000', country: 'AU' }, { country: 'AU', city: 'MELBOURNE' }],
			['postal_nearby', { code: '3000', country: 'AU' }, { country: 'AU', nearby: [{ city: 'MELBOURNE' }] }],
			['postal_distance', { from: '3000', to: '3004', country: 'AU' }, { country: 'AU', from: { city: 'MELBOURNE' }, to: { city: 'MELBOURNE' } }],
		]) {
			record = payload;
			const result = await target.call(name, args);
			assert.deepEqual(body(result), payload);
			assert.match(result.result.content[1].text, /G-NAF/);
			record = { ...payload, country: 'US' };
			assert.equal((await target.call(name, args)).result.content.length, 1);
		}
	}
	for (const transport of ['stdio', 'http']) {
		const compact = await connect('test_key', transport, { mode: 'compact' });
		t.after(() => compact.close());
		record = { postal: '2000', country: 'AU', city: null, localities: [choice] };
		const result = await compact.call('lookup', { operation: 'postal', arguments: { code: '2000', country: 'AU' } });
		assert.deepEqual(body(result), record);
		assert.match(result.result.content[1].text, /G-NAF/);
	}
});

test('Email enrichment preserves the deep triad, nulls and open codes', async (t) => {
	let extra = {};
	const { rpc } = await setup(t, { fetch: () => response({ email: 'jane.doe+news@example.com', ...extra }) });
	for (const next of [
		{}, { deep: {} },
		{ deep: { first_name: null, no_reply: null, tag: null, mail_provider: null, status: null, reason: null } },
		{ deep: { first_name: 'Jane', no_reply: false, tag: 'news', mail_provider: 'future-provider', deliverable: true, catchall: false, status: 'future-status', reason: 'future_reason' }, future: true },
	]) {
		extra = next;
		assert.deepEqual(body(await rpc.call('email', { email: 'jane.doe+news@example.com', deep: true })), { email: 'jane.doe+news@example.com', ...extra });
	}
});

test('Name formatting remains flat and nullable with an optional name locale', async (t) => {
	let detail = {};
	const { rpc, calls } = await setup(t, { fetch: () => response({ name: 'Robert James Smith', deep: detail }) });
	for (const next of [
		{ short: 'R.J. Smith', directory: 'Smith, Robert James', initials: 'RJS' },
		{ short: null, directory: null, initials: null },
		{ gender: null, salutation: null },
		{},
	]) {
		detail = next;
		assert.deepEqual(body(await rpc.call('name', { name: 'Robert James Smith', deep: true, name_locale: 'en-GB' })).deep, detail);
		assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams), { deep: 'true', name_locale: 'en-GB' });
	}
	await rpc.call('name', { name: 'Andrea', deep: true });
	assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams), { deep: 'true' });
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
	const tools = result.result.tools.filter(({ name }) => !['discover', 'preflight'].includes(name));
	const expected = JSON.parse(await readFile(new URL('./public-api.json', import.meta.url), 'utf8'));
	assert.deepEqual(publicSurface(tools), expected);
	assert.equal(tools.length, 68);
	assert.deepEqual([...new Set(cases.map(([name]) => name))].sort(), tools.map(({ name }) => name).sort());
	assert.equal(calls.length, 0);
});

test('hosted scope excludes only ip_self; listing and keyless calls stay offline', async (t) => {
	const { rpc, calls } = await setup(t, { key: null, transport: 'http' });
	const { result } = await rpc.request('tools/list', {});
	assert.equal(result.tools.length, 69);
	assert.equal(result.tools.some(({ name }) => name === 'ip_self'), false);
	assert.equal(result.tools.some(({ name }) => name === 'company_search'), true);
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
		if (name === 'bank' || name === 'bank_us_ach') {
			assert.equal(init.method, 'POST');
			assert.deepEqual(JSON.parse(init.body), name === 'bank' ? args : { format: 'us_ach', country: 'US', ...args });
		}
		assert.equal(init.redirect, 'manual');
		assert.ok(init.signal instanceof AbortSignal);
		const headers = new Headers(init.headers);
		assert.equal(headers.get('x-api-key'), 'test_key');
		assert.equal(headers.get('parse-version'), '2.0.0');
		if (name === 'useragent') assert.equal(headers.get('user-agent'), args.ua);
	});
}

for (const transport of ['stdio', 'http']) {
	test(`${transport} pins the tool contract through retries without changing credentials`, async (t) => {
		let attempts = 0;
		const { rpc, calls } = await setup(t, { transport, fetch: () => ++attempts === 1
			? response({ code: 'unavailable' }, 503) : response({ country: 'US' }) });
		assert.deepEqual(body(await rpc.call('country', { code: 'US' })), { country: 'US' });
		assert.equal(calls.length, 2);
		for (const { url, init } of calls) {
			assert.equal(url.pathname, '/country/US');
			assert.equal(url.search, '');
			assert.equal(new Headers(init.headers).get('parse-version'), '2.0.0');
			assert.equal(new Headers(init.headers).get('x-api-key'), 'test_key');
			assert.equal(init.redirect, 'manual');
		}
	});
}

test('display language reaches each supported tool request and stays request-local', async (t) => {
	const { rpc, calls } = await setup(t);
	const { result } = await rpc.request('tools/list', {});
	const localized = result.tools.filter(tool => tool.inputSchema.properties.lang).map(tool => tool.name);
	assert.equal(localized.length, 30);
	for (const name of localized) {
		const [, args, pathname, query = {}] = cases.find(([candidate]) => candidate === name);
		const called = await rpc.call(name, { ...args, lang: 'zh-Hant-HK' });
		assert.equal(called.result?.isError, undefined, JSON.stringify(called));
		assert.equal(calls.at(-1).url.pathname, pathname);
		assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams), { ...query, lang: 'zh-Hant-HK' });
	}
	for (const name of ['email', 'phone', 'measure', 'currency_rate', 'holiday']) {
		assert.equal(result.tools.find(tool => tool.name === name).inputSchema.properties.lang, undefined);
	}
	await rpc.call('country', { code: 'DE' });
	assert.equal(calls.at(-1).url.searchParams.has('lang'), false);
	await rpc.call('date', { date: '03/04/2026', format: 'dmy', lang: 'fr', deep: true });
	assert.equal(calls.at(-1).url.searchParams.get('format'), 'dmy');
	assert.equal(calls.at(-1).url.searchParams.get('lang'), 'fr');
});

test('search requires query and rejects the retired q input before any HTTP call', async (t) => {
	const { rpc, calls } = await setup(t);
	for (const name of ['city_search', 'address_search', 'tariff_search', 'industry_search', 'emoji_search']) {
		const called = await rpc.call(name, { q: 'coffee' });
		assert.equal(called.result?.isError, true, JSON.stringify(called));
	}
	assert.equal(calls.length, 0);
});

test('ambiguous time input and ignored date options are validation errors', async (t) => {
	const { rpc, calls } = await setup(t);
	for (const args of [{ lat: 0 }, { lon: 0 }, { timezone: '' }, { at: '' }, { to: '' },
		{ timezone: 'UTC', lat: 0, lon: 0 }]) {
		const called = await rpc.call('time', args);
		assert.equal(called.result?.isError, true, JSON.stringify(called));
	}
	for (const args of [{ date: '' }, { format: 'mdy' }]) {
		const called = await rpc.call('date', args);
		assert.equal(called.result?.isError, true, JSON.stringify(called));
	}
	assert.equal(calls.length, 0);
});

test('hosted timezone preserves published arguments and the legacy route', async (t) => {
	const result = { timezone: 'UTC', offset: '+00:00', future: null };
	const { rpc, calls } = await setup(t, { transport: 'http', fetch: () => response(result) });
	for (const [args, path, query] of [
		[{ timezone: 'UTC', at: '', to: '' }, '/timezone/UTC', { at: '', to: '' }],
		[{ lat: 0, lon: 0, at: '2026-09-10T00:00:00Z' }, '/timezone', { lat: '0', lon: '0', at: '2026-09-10T00:00:00Z' }],
	]) {
		const called = await rpc.call('timezone', args);
		assert.equal(called.result?.isError, undefined, JSON.stringify(called));
		assert.deepEqual(body(called), result);
		assert.equal(calls.at(-1).url.pathname, path);
		assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams), query);
	}
	assert.equal(calls.length, 2);
	for (const args of [{}, { lat: 0 }, { timezone: '' }, { timezone: 'UTC', lat: 0, lon: 0 }, { lat: 0, lon: 0, to: 'UTC' }]) {
		const called = await rpc.call('timezone', args);
		assert.equal(called.result?.isError, true, JSON.stringify(called));
	}
	assert.equal(calls.length, 2, 'Rejected legacy inputs must not make an API request');
});

test('API errors preserve machine-readable details', async (t) => {
	const error = { code: 'not_found', message: 'No match', docs: 'https://parseapi.com/docs#not_found', request_id: 'req_test' };
	const { rpc, calls } = await setup(t, { fetch: () => response(error, 404) });
	const called = await rpc.call('city', { name: 'missing' });
	assert.equal(called.result.isError, true);
	assert.deepEqual(body(called), { ...error, retry_after: '0' });
	assert.equal(calls.length, 1);
});

test('Card preserves longest-match data and rejects numeric arguments without dropping zeros', async (t) => {
	const data = { bin: '00123456', prefix: '001234', country: null, issuer: null, brand: null, type: null, prepaid: false };
	const { rpc, calls } = await setup(t, { fetch: () => response(data) });
	assert.deepEqual(body(await rpc.call('card', { bin: '00123456' })), data);
	const malformed = await rpc.call('card', { bin: 123456 });
	assert.equal(malformed.result?.isError, true);
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


test('measurement choices and exact amounts stay structured without becoming tool errors', async (t) => {
	const fixture = { measure: '1 gallon', valid: false, type: null, amount: null, unit: null, reason: 'ambiguous_unit', choices: [{ unit: 'us_gal', name: 'US liquid gallon' }], future: null };
	const { rpc } = await setup(t, { fetch: () => response(fixture) });
	const result = await rpc.call('measure', { measure: '1 gallon' });
	assert.equal(result.result?.isError, undefined);
	assert.deepEqual(body(result), fixture);
});

test('measurement bounds and system reject invalid arguments before HTTP', async (t) => {
	const { rpc, calls } = await setup(t);
	for (const args of [{ measure: '' }, { measure: 'x'.repeat(257) }, { measure: '1 gallon', system: 'guessed' }, { measure: '1 m', to: '' }]) {
		assert.equal((await rpc.call('measure', args)).result?.isError, true);
	}
	assert.equal(calls.length, 0);
});

test('incompatible measurement target preserves the API error', async (t) => {
	const error = { code: 'bad_request', message: 'Incompatible measurement units', docs: null, request_id: 'req_measure' };
	const { rpc, calls } = await setup(t, { fetch: () => response(error, 400) });
	const result = await rpc.call('measure', { measure: '1 m', to: 'kg' });
	assert.equal(result.result.isError, true);
	assert.deepEqual(body(result), { ...error, retry_after: '0' });
	assert.equal(calls.length, 1);
});


test('DNS types validate before HTTP and presentation records stay verbatim', async (t) => {
	const expected = { domain: 'example.com', records: [{ name: 'example.com.', type: 'TXT', ttl: 0, value: '"one" "two"', future: null }] };
	const { rpc, calls } = await setup(t, { fetch: () => response(expected) });
	const invalid = await rpc.call('dns', { domain: 'example.com', type: 'ANY' });
	assert.equal(invalid.result?.isError, true);
	assert.equal(calls.length, 0);
	assert.deepEqual(body(await rpc.call('dns', { domain: 'example.com', type: 'TXT' })), expected);
	assert.equal(calls.length, 1);
});


test('NAICS preserves exclusions, actual search evidence and original query text', async (t) => {
 const records = [{"naics":"541511","name":"Custom Computer Programming Services","description":null,"level":6,"parent":"54151","parent_name":"Computer Systems Design and Related Services","children":[],"year":2022,"country":"US"},{"naics":"541511","name":"Custom Computer Programming Services","description":null,"level":6,"parent":"54151","parent_name":"Computer Systems Design and Related Services","children":[],"year":2022,"country":"US","exclusions":null,"match":null},{"naics":"541511","name":"Custom Computer Programming Services","description":null,"level":6,"parent":"54151","parent_name":"Computer Systems Design and Related Services","children":[],"year":2022,"country":"US","exclusions":[],"match":{"field":"future-field","text":"Future matching evidence","corrections":[],"future":true}},{"naics":"541511","name":"Custom Computer Programming Services","description":null,"level":6,"parent":"54151","parent_name":"Computer Systems Design and Related Services","children":[],"year":2022,"country":"US","exclusions":[{"description":"Designing integrated computer systems","codes":[{"naics":"541512","name":"Computer Systems Design Services"}]},{"description":"Activities classified elsewhere","codes":[]}],"match":{"field":"term","text":"Computer software programming services","corrections":[{"from":"sofware","to":"software"}]},"future":true}];
 const data = { q: 'sofware', year: 2022, country: 'US', results: records };
 const { rpc, calls } = await setup(t, { fetch: () => response(data) });
 const called = await rpc.call('industry_search', { query: 'sofware' });
 assert.deepEqual(body(called), data);
 assert.equal(calls[0].url.searchParams.get('q'), 'sofware');
});


test('name_local and null pass through every named tool response', async (t) => {
 let data;
 const { rpc } = await setup(t, { fetch: () => response(data) });
 for (const name_local of ['München', null]) {
  const record = { name: 'Munich', name_local };
  for (const [tool, args, value] of [
   ['country', { code: 'DE' }, record],
   ['state', { code: 'BY' }, record],
   ['city', { name: 'Munich' }, record],
   ['language', { code: 'de' }, record],
   ['holiday', { country: 'DE' }, { holidays: [record] }],
   ['point', { lat: 48, lon: 11, deep: true }, { deep: { city: record } }],
  ]) {
   data = value;
   assert.deepEqual(body(await rpc.call(tool, args)), data);
  }
 }
});

test('Stack preserves homepage and site inventories with multiple CMS and servers', async (t) => {
 let record;
 const { rpc } = await setup(t, { fetch: () => response(record) });
 for (const next of [{"domain":"xn--bcher-kva.example","url":"https://xn--bcher-kva.example/","checked_at":null,"scope":"homepage","pages":0,"partial":null,"cms":null,"servers":null,"frameworks":null,"ecommerce":null,"analytics":null,"chat":null,"payments":null,"hosting":null,"future":true},{"domain":"xn--bcher-kva.example","url":"https://xn--bcher-kva.example/","checked_at":"2026-09-21T12:00:00Z","scope":"homepage","pages":1,"partial":true,"cms":[],"servers":[],"frameworks":[],"ecommerce":[],"analytics":[],"chat":[],"payments":[],"hosting":[],"deep":{},"future":true},{"domain":"xn--bcher-kva.example","url":"https://xn--bcher-kva.example/","checked_at":"2026-09-21T12:00:00Z","scope":"homepage","pages":1,"partial":true,"cms":[{"technology":"wordpress","name":"WordPress","version":"6.8.2"}],"servers":[{"technology":"nginx","name":"nginx","version":null}],"frameworks":[{"technology":"react","name":"React","version":null}],"ecommerce":[],"analytics":[],"chat":[],"payments":[],"hosting":[],"future":true},{"domain":"xn--bcher-kva.example","url":"https://xn--bcher-kva.example/","checked_at":"2026-09-21T12:00:00Z","scope":"site","pages":6,"partial":false,"cms":[{"technology":"wordpress","name":"WordPress","version":"6.8.2"},{"technology":"ghost","name":"Ghost","version":null}],"servers":[{"technology":"nginx","name":"nginx","version":null},{"technology":"apache","name":"Apache","version":null}],"frameworks":[{"technology":"nextjs","name":"Next.js","version":"15.0.0","future":true},{"technology":"react","name":"React","version":null}],"ecommerce":[{"technology":"woocommerce","name":"WooCommerce","version":null}],"analytics":[{"technology":"google-analytics","name":"Google Analytics","version":null}],"chat":[{"technology":"intercom","name":"Intercom","version":null}],"payments":[{"technology":"stripe","name":"Stripe","version":null}],"hosting":[{"technology":"vercel","name":"Vercel","version":null}],"future":true},{"domain":"xn--bcher-kva.example","url":"https://xn--bcher-kva.example/","checked_at":"2026-09-21T12:00:00Z","scope":"site","pages":3,"partial":true,"cms":[],"servers":[],"frameworks":[{"technology":"nextjs","name":"Next.js","version":null,"future":true}],"ecommerce":[],"analytics":[],"chat":[],"payments":[],"hosting":[],"deep":{},"future":true},{"domain":"xn--bcher-kva.example","url":"https://xn--bcher-kva.example/","checked_at":null,"scope":"site","pages":0,"partial":null,"cms":null,"servers":null,"frameworks":null,"ecommerce":null,"analytics":null,"chat":null,"payments":null,"hosting":null,"deep":{},"future":true}]) {
  record = next;
  assert.deepEqual(body(await rpc.call('stack', { domain: 'bücher.example', pretty: true })), record);
 }
});


test('Stack allows a cold scan without changing other tool deadlines', async (t) => {
	const timer = t.mock.method(globalThis, 'setTimeout');
	const { rpc } = await setup(t);
	await rpc.call('stack', { domain: 'example.com' });
	assert.ok(timer.mock.calls.some(call => call.arguments[1] === 35000));
	timer.mock.resetCalls();
	await rpc.call('country', { code: 'US' });
	assert.ok(timer.mock.calls.some(call => call.arguments[1] === 10000));
	assert.ok(timer.mock.calls.every(call => call.arguments[1] !== 35000));
});
