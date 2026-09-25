import assert from 'node:assert/strict';
import { test } from 'node:test';
import { body, connect } from './helpers.mjs';

for (const transport of ['stdio', 'http']) {
	for (const mode of ['full', 'compact']) {
		test(`Time conversion policy and errors survive ${transport} ${mode}`, async t => {
			const calls = [];
			let status = 200;
			let payload = { timezone: null, at: null, unix: null, to: null };
			t.mock.method(globalThis, 'fetch', async (input, init) => {
				calls.push({ url: new URL(input), init });
				return new Response(JSON.stringify(payload), { status });
			});
			const rpc = await connect('test_key', transport, { mode });
			t.after(() => rpc.close());
			const time = args => mode === 'full' ? rpc.call('time', args)
				: rpc.call('lookup', { operation: 'time', arguments: args });
			await time({});
			assert.equal(calls.at(-1).url.pathname, '/time');
			assert.equal(calls.at(-1).url.search, '');
			for (const disambiguation of ['compatible', 'earlier', 'later', 'reject']) {
				for (const context of [{ timezone: 'America/New_York' }, { lat: 40.71, lon: -74.01 }]) {
					assert.deepEqual(body(await time({ ...context, at: '2026-11-01T01:30:00', to: 'UTC', disambiguation })), payload);
					assert.equal(calls.at(-1).url.searchParams.get('disambiguation'), disambiguation);
					assert.equal(calls.at(-1).url.searchParams.get('at'), '2026-11-01T01:30:00');
					assert.equal(new Headers(calls.at(-1).init.headers).get('Parse-Version'), '2.0.0');
				}
			}
			const before = calls.length;
			for (const disambiguation of ['', 'guess', null, 0]) {
				assert.equal((await time({ timezone: 'UTC', disambiguation })).result.isError, true);
			}
			assert.equal(calls.length, before, 'Invalid policies must not dispatch');
			status = 400;
			payload = { code: 'ambiguous_time', message: 'Query at is ambiguous in the source timezone; pass an explicit UTC offset or choose disambiguation=earlier or later', docs: 'https://parseapi.com/docs#invalid_request', request_id: 'req_clock' };
			const rejected = await time({ timezone: 'America/New_York', at: '2026-11-01T01:30:00', to: 'UTC', disambiguation: 'reject' });
			assert.equal(rejected.result.isError, true);
			assert.deepEqual(body(rejected), payload);
			assert.equal(calls.length, before + 1, 'A rejected local time must not be retried');
		});
	}
}

test('Time discovery includes reviewed clock uncertainty and pooled depth without HTTP', async t => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new Error('Discovery is local'); });
	const rpc = await connect(null, 'http', { mode: 'compact' });
	t.after(() => rpc.close());
	const result = body(await rpc.call('discover', { operation: 'time' })).operations[0];
	assert.equal(result.policy_available, true);
	assert.equal(result.policy.freshness.timezone_database_version, '2026c');
	assert.equal(result.policy.freshness.cache_control, 'no-store');
	assert.equal(result.policy.billing.metered, null);
	assert.equal(result.policy.billing.conversion_extra_units, 0);
	assert.equal(result.policy.billing.deep_extra_units, 0);
	assert.match(result.policy.uncertainty.http_status['400'], /repeated\/nonexistent/);
	assert.deepEqual(result.inputSchema.properties.disambiguation.enum, ['compatible', 'earlier', 'later', 'reject']);
	assert.equal(calls, 0);
});

for (const transport of ['stdio', 'http']) {
 for (const mode of ['full', 'compact']) {
  test(`Time zone discovery and multiple targets preserve one request and uncertainty (${transport}, ${mode})`, async t => {
   const calls = [];
   let status = 200;
   let payload = { timezone_database_version: '2026c', timezones: [] };
   t.mock.method(globalThis, 'fetch', async input => { calls.push(new URL(input)); return new Response(JSON.stringify(payload), { status }); });
   const rpc = await connect('test_key', transport, { mode });
   t.after(() => rpc.close());
   const invoke = (name, args) => mode === 'full' ? rpc.call(name, args) : rpc.call('lookup', { operation: name, arguments: args });
   assert.deepEqual(body(await invoke('time_zones', {})), payload);
   assert.equal(calls.at(-1).pathname, '/time/zones');
   assert.equal(calls.at(-1).search, '');
   assert.deepEqual(body(await invoke('time_zones', { query: 'New York' })), payload);
   assert.equal(calls.at(-1).searchParams.get('q'), 'New York');
   const before = calls.length;
   for (const args of [{ targets: [] }, { targets: [''] }, { targets: ['UTC,UTC'] }, { targets: ['x'.repeat(65)] }, { targets: Array(11).fill('UTC') }, { targets: ['UTC'], to: 'UTC' }]) {
    assert.equal((await invoke('time', { timezone: 'UTC', ...args })).result.isError, true);
   }
   assert.equal((await invoke('time_zones', { query: 'x'.repeat(65) })).result.isError, true);
   assert.equal(calls.length, before);
   for (const targets of [null, [], [{ timezone: 'UTC', unix: 0 }, { timezone: 'UTC', unix: 0 }]]) {
    payload = { targets };
    const result = await invoke('time', { timezone: 'UTC', targets: ['UTC', 'Asia/Tokyo', 'UTC'], deep: true });
    assert.deepEqual(body(result), payload);
    assert.equal(calls.at(-1).searchParams.get('targets'), 'UTC,Asia/Tokyo,UTC');
   }
   assert.equal(calls.length, before + 3, 'One request per multi-zone conversion');
   status = 404;
   payload = { code: 'not_found', message: 'Unknown timezone', docs: null, request_id: 'req_targets' };
   const result = await invoke('time', { lat: 0, lon: 0, targets: ['UTC', 'Unknown/Zone'] });
   assert.equal(result.result.isError, true);
   assert.deepEqual(body(result), payload);
   assert.equal(calls.length, before + 4, 'Unknown targets do not retry or emit partial results');
   const discovery = body(await rpc.call('discover', { operation: 'time_zones' })).operations[0];
   assert.equal(discovery.policy_available, true);
   assert.equal(discovery.policy.billing.metered, null);
  });
 }
}


for (const mode of ['full', 'compact']) {
 test(`Time recovery codes, rule provenance and retry timing remain actionable (${mode})`, async t => {
  let calls = 0;
  let status = 200;
  let payload = { deep: { timezone_database_version: '2026c', resolution: { kind: 'gap', policy: 'earlier', adjustment_seconds: -1800, alternatives: [{ at: '1970-01-01T00:00:00.123+00:00', unix: 0, offset: '+00:00' }] } } };
  let headers = {};
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(payload), { status, headers }); });
  const rpc = await connect('test_key', 'stdio', { mode }); t.after(() => rpc.close());
  const invoke = (name, args) => mode === 'full' ? rpc.call(name, args) : rpc.call('lookup', { operation: name, arguments: args });
  assert.deepEqual(body(await invoke('time', { timezone: 'UTC', to: 'UTC', deep: true })), payload);
  for (const zone of ['zones', 'help', ' ZONES ', 'Help']) assert.equal((await invoke('time', { timezone: zone })).result.isError, true);
  assert.equal(calls, 1);
  for (const code of ['ambiguous_time', 'nonexistent_time']) {
   status = 400; payload = { code, message: 'Choose an explicit offset or earlier/later', docs: null, request_id: 'req_clock' };
   assert.deepEqual(body(await invoke('time', { timezone: 'America/New_York', at: '2026-11-01T01:30:00', to: 'UTC', disambiguation: 'reject' })), payload);
  }
  assert.equal(calls, 3);
  status = 429; headers = { 'Retry-After': '60' }; payload = { code: 'rate_limited', message: 'Try later', docs: null, request_id: 'req_time' };
  assert.deepEqual(body(await invoke('time_zones', {})), { ...payload, retry_after: '60' });
  assert.equal(calls, 4, 'Long retry delay returns promptly without shortened waits');
 });
 for (const operation of ['time', 'time_zones']) {
  test(`Time cancellation reaches the SDK without retries (${mode}, ${operation})`, async t => {
   let started, aborted; let calls = 0;
   const fetching = new Promise(resolve => { started = resolve; });
   const cancelled = new Promise(resolve => { aborted = resolve; });
   t.mock.method(globalThis, 'fetch', (_input, init) => new Promise((_, reject) => {
    calls++; init.signal.addEventListener('abort', () => { aborted(); reject(init.signal.reason); }, { once: true }); started();
   }));
   const rpc = await connect('test_key', 'stdio', { mode });
   const args = operation === 'time' ? { timezone: 'UTC', targets: ['UTC'] } : { query: 'New York' };
   const pending = rpc.startRequest('tools/call', mode === 'full' ? { name: operation, arguments: args } : { name: 'lookup', arguments: { operation, arguments: args } });
   await fetching; await rpc.notify('notifications/cancelled', { requestId: pending.id, reason: 'Stopped Time' }); await cancelled;
   assert.equal(calls, 1); await rpc.close(); await pending.response;
  });
 }
}

for (const mode of ['full', 'compact']) {
 test(`Time explicit locations and rich catalog preserve uncertainty and false filters (${mode})`, async t => {
  const calls=[];
  const payload={timezone:null,targets:null,location:{input:{type:'city',value:'Springfield'},status:'ambiguous',candidates:[],truncated:false,source:'city_reference'},deep:{standard_offset_seconds:3600,dst_offset_seconds:-3600,season:null}};
  t.mock.method(globalThis,'fetch',async input=>{calls.push(new URL(input));return new Response(JSON.stringify(payload));});
  const rpc=await connect('test_key','stdio',{mode});t.after(()=>rpc.close());
  const invoke=(name,args)=>mode==='full'?rpc.call(name,args):rpc.call('lookup',{operation:name,arguments:args});
  const filters={country:'US',area:'America',offset:'+00:00',abbreviation:'UTC',dst:false,observes_dst:false,at:'1970-01-01T00:00:00Z',details:true,sort:'offset'};
  assert.deepEqual(body(await invoke('time_zones',filters)),payload);
  assert.equal(calls.at(-1).pathname,'/time/zones');
  assert.deepEqual(Object.fromEntries(calls.at(-1).searchParams),Object.fromEntries(Object.entries(filters).map(([key,value])=>[key,String(value)])));
  for (const source of [{ip:'2001:db8::1'},{city:'Springfield',country:'US',state:'IL'},{country:'US'},{iata:'JFK'},{icao:'KJFK'},{unlocode:'US NYC'},{address:'1 Main Street',country:'US',state:'NY'}]) {
   assert.deepEqual(body(await invoke('time',source)),payload);
   assert.equal(calls.at(-1).pathname,'/time');
   for (const [key,value] of Object.entries(source)) assert.equal(calls.at(-1).searchParams.get(key),value);
  }
  const count=calls.length;
  for (const source of [{ip:'8.8.8.8',city:'Paris'},{ip:'8.8.8.8',country:'US'},{state:'NY'},{city:'Paris',state:'IDF'},{address:'a'},{ip:' '},{timezone:'UTC',city:'Paris'},{lat:0,lon:0,iata:'JFK'},{unlocode:'USN01'}]) assert.equal((await invoke('time',source)).result.isError,true);
  assert.equal(calls.length,count);
 });
}
