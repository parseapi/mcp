import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';

for (const transport of ['stdio', 'http']) {
	for (const mode of ['full', 'compact']) {
		test(`Elevation selectors, encoding and long-list POST on ${transport} ${mode}`, async t => {
			const calls = [];
			const result = { points: [
				{ latitude: 0, longitude: 0, elevation: 0, elevation_ft: 0, resolution: 460 },
				{ latitude: 1, longitude: 2, elevation: -427, elevation_ft: -1401, resolution: 30 },
				{ latitude: 0, longitude: 0, elevation: null, elevation_ft: null, resolution: null },
			] };
			t.mock.method(globalThis, 'fetch', async (input, init) => {
				calls.push({ url: new URL(String(input)), init });
				return new Response(JSON.stringify(result));
			});
			const rpc = await connect('fixture', transport, { mode });
			t.after(() => rpc.close());
			const call = args => mode === 'full'
				? rpc.call('elevation', args)
				: rpc.call('lookup', { operation: 'elevation', arguments: args });

			for (const args of [
				{}, { lat: 0 }, { lon: 0 }, { points: '' }, { points: 'x'.repeat(12001) },
				{ lat: 0, lon: 0, points: '0,0' }, { lat: 0, points: '0,0' }, { lon: 0, points: '0,0' },
				{ locations: '0,0' }, { lat: 91, lon: 0 }, { lat: 0, lon: -181 },
				{ path: '0,0|0,2' }, { samples: 3 }, { path: '', samples: 3 }, { path: 'x'.repeat(12001), samples: 3 },
				{ path: '0,0|0,2', samples: 1 }, { path: '0,0|0,2', samples: 513 },
				{ path: '0,0|0,2', samples: 2.5 }, { path: '0,0|0,2', samples: '3' },
				{ lat: 0, lon: 0, samples: 3 }, { points: '0,0|0,2', samples: 3 },
				{ lat: 0, lon: 0, path: '0,0|0,2', samples: 3 },
				{ lat: 0, path: '0,0|0,2', samples: 3 }, { lon: 0, path: '0,0|0,2', samples: 3 },
				{ points: '0,0', path: '0,0|0,2', samples: 3 },
			]) {
				const invalid = await call(args);
				assert.equal(invalid.result?.isError, true, JSON.stringify({ args, invalid }));
			}
			assert.equal(calls.length, 0, 'Invalid selector combinations must not make a lookup');

			assert.deepEqual(body(await call({ lat: 0, lon: 0 })), result);
			assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams), { lat: '0', lon: '0' });
			for (const points of ['0,0|1,2|0,0', 'enc:_p~iF~ps|U_ulLnnqC_mqNvxq`@']) {
				assert.deepEqual(body(await call({ points })), result);
				assert.equal(calls.at(-1).url.searchParams.get('points'), points);
				assert.equal(calls.at(-1).init.method, undefined);
			}
			const points = Array.from({ length: 512 }, () => '38.5,-120.2').join('|');
			assert.deepEqual(body(await call({ points })), result);
			const post = calls.at(-1);
			assert.equal(post.url.pathname, '/elevation');
			assert.equal(post.url.search, '');
			assert.equal(post.init.method, 'POST');
			assert.deepEqual(JSON.parse(post.init.body), { points });
			assert.equal(new Headers(post.init.headers).get('content-type'), 'application/json');
			for (const path of ['0,0|0,2', 'enc:_p~iF~ps|U_ulLnnqC_mqNvxq`@']) {
				assert.deepEqual(body(await call({ path, samples: 3 })), result);
				assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams), { path, samples: '3' });
				assert.equal(calls.at(-1).init.method, undefined);
			}
			assert.deepEqual(body(await call({ path: points, samples: 512 })), result);
			const pathPost = calls.at(-1);
			assert.equal(pathPost.url.search, '');
			assert.equal(pathPost.init.method, 'POST');
			assert.deepEqual(JSON.parse(pathPost.init.body), { path: points, samples: 512 });
			for (const { init } of calls) {
				assert.equal(new Headers(init.headers).get('parse-version'), '2.0.0');
				assert.equal(new Headers(init.headers).get('x-api-key'), 'fixture');
				assert.ok(init.signal instanceof AbortSignal);
			}
		});
	}
}
