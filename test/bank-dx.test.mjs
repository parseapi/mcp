import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {connect, body} from './helpers.mjs';

const kit = JSON.parse(await readFile(new URL('./bank-public-fixtures.json', import.meta.url), 'utf8'));
for (const transport of ['stdio', 'http']) for (const mode of ['full', 'compact']) {
	test(`published Bank fixture kit and private bodies survive ${transport} ${mode}`, async t => {
		let row;
		t.mock.method(globalThis, 'fetch', async (url, init) => {
			assert.equal(new URL(String(url)).pathname + new URL(String(url)).search, '/bank');
			assert.equal(init.method, 'POST');
			assert.deepEqual(JSON.parse(init.body), row.request.body);
			assert.equal(new Headers(init.headers).get('Parse-Version'), '2.0.0');
			return new Response(JSON.stringify(row.response.body), { status: row.response.status, headers: { ...row.response.headers, 'Retry-After': '0' } });
		});
		const rpc = await connect('fixture', transport, {mode});
		t.after(()=>rpc.close());
		for (row of kit.cases) {
			const {format, country, ...input} = row.request.body;
			const operation = format === 'us_ach' ? 'bank_us_ach' : 'bank';
			const args = format === 'us_ach' ? input : row.request.body;
			const response = await rpc.call(mode === 'compact' ? 'lookup' : operation, mode === 'compact' ? {operation, arguments:args} : args);
			if (row.response.status < 400) {
				assert.notEqual(response.result.isError, true, row.id);
				assert.deepEqual(body(response), row.response.body, row.id);
				if (operation === 'bank_us_ach' && row.response.body.bank_name) {
					assert.equal(response.result.content[1].text, 'Routing reference attribution: https://parseapi.com/legal/attribution#routing-numbers');
				} else assert.equal(response.result.content.length, 1);
			} else {
				assert.equal(response.result.isError, true);
				assert.equal(body(response).code, 'service_unavailable');
				assert.equal(body(response).message, row.response.body.message);
				assert.equal(body(response).request_id, 'bank-fixture');
			}
		}
	});
}
