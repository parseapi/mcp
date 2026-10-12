import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { connect, body } from './helpers.mjs';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'retry-after': '0', ...headers } });
const histories = { from: '2026-10-09', to: '2026-10-10' };
async function setup(t, { transport = 'stdio', mode = 'full', key = 'test_key', respond = () => json({}) } = {}) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (input, init) => {
		const call = { url: new URL(String(input)), init }; calls.push(call); return respond(call, calls.length);
	});
	const rpc = await connect(key, transport, { mode }); t.after(() => rpc.close()); return { rpc, calls };
}

test('old rate calls and optional reference controls preserve raw JSON and exact request', async t => {
	const payload = { base: 'USD', quote: 'XCG', rate: 1.79, date: '2026-10-09', converted: null, future: true };
	const { rpc, calls } = await setup(t, { respond: () => json(payload) });
	assert.deepEqual(body(await rpc.call('currency_rate', { base: 'USD', quote: 'XCG' })), payload);
	assert.equal(calls[0].url.search, '');
	assert.deepEqual(body(await rpc.call('currency_rate', { base: 'USD', quote: 'XCG',  amount: 0 })), payload);
	assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), { amount: '0' });
	assert.equal(new Headers(calls[1].init.headers).get('Parse-Version'), '2.0.0');
});

test('new JSON operations retain explicit gaps and use one operation on both transports and catalog modes', async t => {
	const batch = { base: 'USD', rates: { JPY: { rate: 149.1, date: '2026-10-09', converted: 0 } }, missing: [{ quote: 'XCG', reason: 'no_rate' }], future: true };
	const payloads = {
		'/currency': { data: [], future: true },
		'/currency/USD/rates': batch,
		'/currency/USD/JPY/history': { base: 'USD', quote: 'JPY', ...histories, data: [], missing: ['2026-10-10'], future: true },
		'/currency/USD/rates/history': { base: 'USD', quotes: ['JPY', 'XCG'], ...histories, data: [], missing: [{ quote: 'XCG', requested_date: '2026-10-10', reason: 'no_rate' }], future: true },
	};
	for (const transport of ['stdio', 'http']) for (const mode of ['full', 'compact']) {
		await t.test(`${transport} ${mode}`, async t => {
			const { rpc, calls } = await setup(t, { transport, mode, respond: ({ url }) => json(payloads[url.pathname]) });
			for (const [name, args, path] of [
				['currency_list', { q: 'gold', country: 'UA', deep: true, lang: 'fr' }, '/currency'],
				['currency_rates', { base: 'USD', }, '/currency/USD/rates'],
				['currency_rates', { base: 'USD', quotes: ['JPY', 'XCG'],  amount: 0 }, '/currency/USD/rates'],
				['currency_history', { base: 'USD', quote: 'JPY', ...histories, }, '/currency/USD/JPY/history'],
				['currency_rates_history', { base: 'USD', quotes: ['JPY', 'XCG'], ...histories }, '/currency/USD/rates/history'],
			]) {
				const result = await rpc.call(mode === 'compact' ? 'lookup' : name, mode === 'compact' ? { operation: name, arguments: args } : args);
				assert.deepEqual(body(result), payloads[path]); assert.equal(calls.at(-1).url.pathname, path);
				if (name === 'currency_rates') {
					assert.equal(body(result).rates.JPY.rate, 149.1);
					assert.equal(body(result).rates.JPY.converted, 0);
					assert.equal('quote' in body(result).rates.JPY, false);
				}
			}
			assert.equal(calls.length, 5);
			assert.equal(calls[0].url.searchParams.get('lang'), 'fr');
			assert.deepEqual(Object.fromEntries(calls[2].url.searchParams), { quotes: 'JPY,XCG',  amount: '0' });
		});
	}
});



test('new currency validation occurs before a request and discovery remains local', async t => {
	const { rpc, calls } = await setup(t, { mode: 'compact' });
	for (const [operation, args] of [
		['currency_rate', { base: 'USD', quote: 'EUR', source: 'ecb' }],
		['currency_rates', { base: 'USD', quotes: [] }],
		['currency_rates', { base: 'USD', quotes: ['JPY', 'jpy'] }],
		['currency_rates', { base: 'USD', quotes: Array(51).fill('JPY') }],
		['currency_history', { base: 'USD', quote: 'JPY', ...histories, amount: 1e15 + 1 }],
	]) assert.equal((await rpc.call('lookup', { operation, arguments: args })).result.isError, true);
	const discovered = body(await rpc.call('discover', { operation: 'currency_rates_history' }));
	assert.equal(discovered.operations[0].name, 'currency_rates_history'); assert.ok(discovered.operations[0].inputSchema.properties.from);
	assert.equal(calls.length, 0);
});

test('new tools preserve the keyless signup funnel', async t => {
	const { rpc, calls } = await setup(t, { key: null });
	for (const [name, args] of [['currency_list', {}], ['currency_history', { base: 'USD', quote: 'JPY', ...histories }]]) {
		const result = await rpc.call(name, args); assert.equal(result.result.isError, true); assert.equal(body(result).code, 'invalid_api_key');
	}
	assert.equal(calls.length, 0);
});



const reporting = JSON.parse(readFileSync(new URL('./fixtures/currency-summary.json', import.meta.url), 'utf8'));
test('complete observation summary and sampled history work in both transports and modes', async t => {
    for (const transport of ['stdio', 'http']) for (const mode of ['full', 'compact']) {
        await t.test(`${transport} ${mode}`, async t => {
            const {rpc,calls} = await setup(t,{transport,mode,respond:({url}) => json(url.pathname.endsWith('/summary') ? reporting.summary : reporting.sampled_history)});
            const invoke = (name,args) => rpc.call(mode === 'compact' ? 'lookup' : name, mode === 'compact' ? {operation:name,arguments:args}:args);
            const summaryArgs = {base:'USD',quotes:['EUR'],from:'1999-01-01',to:'1999-01-31',interval:'month', };
            const discovered = body(await rpc.call('discover', {operation:'currency_rates_summary'}));
            assert.equal(discovered.operations[0].name,'currency_rates_summary');
            assert.ok(discovered.operations[0].inputSchema.properties.interval);
            assert.equal(discovered.operations[0].policy_available,true);
            assert.ok(discovered.operations[0].policy.determines);
            assert.match(JSON.stringify(discovered.operations[0].policy),/observation/i);
            assert.deepEqual(body(await invoke('currency_rates_summary',summaryArgs)), reporting.summary);
            assert.deepEqual(Object.fromEntries(calls[0].url.searchParams),{quotes:'EUR',from:'1999-01-01',to:'1999-01-31',interval:'month', });
            assert.equal(calls[0].url.pathname,'/currency/USD/rates/summary');
            const historyArgs = {base:'USD',quote:'JPY',from:'1999-01-01',to:'2026-10-09',interval:'month', };
            assert.deepEqual(body(await invoke('currency_history',historyArgs)), reporting.sampled_history);
            assert.equal(calls[1].url.searchParams.get('interval'),'month');
            for (const [name,args] of [
                ['currency_rates_history',{base:'USD',quotes:['JPY'],...histories,interval:'week'}],
            ]) { await invoke(name,args); assert.equal(calls.at(-1).url.searchParams.get('interval'),args.interval); }
            const before = calls.length;
            assert.equal((await invoke('currency_rates_summary',{...summaryArgs,interval:'week'})).result.isError,true);
            assert.equal((await invoke('currency_history',{...historyArgs,interval:'year'})).result.isError,true);
            assert.equal((await invoke('currency_rates_summary',{...summaryArgs,format:'csv'})).result.isError,true);
            assert.equal(calls.length,before);
        });
    }
});
