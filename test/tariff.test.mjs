import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';

for (const transport of ['stdio', 'http']) {
	test(`tariff search keeps parent context on ${transport}`, async t => {
		const payload = { q: 'horses & ponies', revision: 'fixture', lines: [{ hts: '0101.29.00.90', description: 'Other', general: null, lineage: ['Live horses', 'Other horses'], future: true }] };
		t.mock.method(globalThis, 'fetch', async input => {
			const url = new URL(String(input));
			assert.equal(url.pathname, '/tariff');
			assert.deepEqual(Object.fromEntries(url.searchParams), { q: 'horses & ponies' });
			return new Response(JSON.stringify(payload));
		});
		const rpc = await connect('test', transport);
		t.after(() => rpc.close());
		assert.deepEqual(body(await rpc.call('tariff_search', { query: 'horses & ponies' })), payload);
	});
}

for (const transport of ['stdio', 'http']) {
	test(`tariff edition/date options and open reason roundtrip on ${transport}`, async t => {
		const edition = 'a'.repeat(64);
		const payload = { hts: '0101', edition, date: '2026-09-15', deep: { reason: 'future_reason', effective_rate: null, measures: [] } };
		const seen = [];
		t.mock.method(globalThis, 'fetch', async input => {
			const url = new URL(String(input));
			seen.push(Object.fromEntries(url.searchParams));
			return new Response(JSON.stringify(payload));
		});
		const rpc = await connect('test', transport);
		t.after(() => rpc.close());
		assert.deepEqual(body(await rpc.call('tariff', { code: '0101', origin: 'CA', deep: true, edition, date: '2026-09-15' })), payload);
		assert.deepEqual(body(await rpc.call('tariff_search', { query: 'horses', edition, date: '2026-09-15' })), payload);
		assert.deepEqual(seen, [{ origin: 'CA', edition, date: '2026-09-15', deep: 'true' }, { q: 'horses', edition, date: '2026-09-15' }]);
	});
}

for (const transport of ['stdio', 'http']) {
	test(`tariff refuses ignored selection on ${transport}`, async t => {
		t.mock.method(globalThis, 'fetch', async () => new Response('{"revision":"old"}'));
		const rpc = await connect('test', transport);
		t.after(() => rpc.close());
		for (const [name, args] of [['tariff', { code: '0101', edition: 'a'.repeat(64) }], ['tariff_search', { query: 'horses', date: '2026-09-15' }]]) {
			const result = await rpc.call(name, args);
			assert.equal(result.result.isError, true);
			assert.equal(body(result).code, 'tariff_selection_mismatch');
		}
	});
}

for (const transport of ['stdio', 'http']) {
	test(`tariff date selection requires a valid edition on ${transport}`, async t => {
		let edition;
		t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ edition, date: '2026-09-15' })));
		const rpc = await connect('test', transport);
		t.after(() => rpc.close());
		for (edition of ['legacy', '', 'A'.repeat(64), `${'a'.repeat(64)}\n`]) {
			for (const [name, args] of [['tariff', { code: '0101', date: '2026-09-15' }], ['tariff_search', { query: 'horses', date: '2026-09-15' }]]) {
				const result = await rpc.call(name, args);
				assert.equal(result.result.isError, true);
				assert.equal(body(result).code, 'tariff_selection_mismatch');
			}
		}
	});
}
