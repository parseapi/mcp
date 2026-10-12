import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { connect, body } from './helpers.mjs';

for (const transport of ['stdio', 'http']) for (const mode of ['full', 'compact']) {
	test(`Emoji discovery exposes bounded factual policies without HTTP on ${transport}/${mode}`, async t => {
		let requests = 0;
		t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Discovery must stay local'); });
		const rpc = await connect(null, transport, { mode }); t.after(() => rpc.close());
		const names = ['emoji', 'emoji_search', 'emoji_browse', 'emoji_metadata', 'emoji_catalog', 'emoji_categories', 'emoji_parse', 'emoji_convert'];
		for (const name of names) {
			const detail = body(await rpc.call('discover', { operation: name }));
			assert.equal(detail.effective_access, 'not_evaluated');
			assert.equal(detail.pricing, 'not_quoted');
			const row = detail.operations[0];
			assert.equal(row.name, name); assert.equal(row.policy_available, true);
			assert.equal(row.policy.operation, name); assert.ok(row.inputSchema);
			assert.equal(row.policy.billing.pooled_requests_per_success, 1);
			assert.equal(Object.hasOwn(row.policy.billing,'metered'),false);
			assert.equal(Object.hasOwn(row.policy.billing,'monetary_quote'),false);
			assert.equal(Object.hasOwn(row.policy.access,'effective_access'),false);
			assert.equal(Object.hasOwn(row.policy.freshness,'actual_age_seconds'),false);
			if (name === 'emoji_catalog') assert.equal(row.policy.billing.mcp_pooled_requests_per_success, 1);
		}
		const summary = body(await rpc.call('discover', { query: 'emoji', limit: 20 }));
		assert.ok(names.every(name => summary.policy_operations.includes(name)));
		assert.equal(requests, 0);
	});
}

for (const transport of ['stdio', 'http']) {
	for (const mode of ['full', 'compact']) {
		test(`emoji catalog and private text body on ${transport}/${mode}`, async t => {
			const calls = [];
			const payload = { total: 2, emojis: [{ emoji: '👍🏿', name: 'thumbs up', shortcodes: [], occurrences: 2, positions: [{start:2,end:6},{start:7,end:11}], deep: {base:'👍',variants:[{emoji:'👍🏿',tones:['dark']}]}}], future:true };
			t.mock.method(globalThis, 'fetch', async (input, init) => {calls.push({url:new URL(String(input)),init});return new Response(JSON.stringify(payload));});
			const rpc=await connect('test',transport,{mode});
			t.after(()=>rpc.close());
			const call=(name,args)=> mode==='compact' ? rpc.call('lookup',{operation:name,arguments:args}) : rpc.call(name,args);
			await call('emoji',{emoji:':cat:',shortcode_source:'github'});
			await call('emoji_search',{query:'face',category:'Smileys & Emotion',max_version:'18.0',include_skin_tones:false,offset:0});
			await call('emoji_browse',{include_skin_tones:false,offset:2});
			await call('emoji_categories',{});
			assert.deepEqual(body(await call('emoji_parse',{text:'x 👍🏿 👍🏿',deep:true,lang:'fr'})),payload);
			assert.deepEqual(Object.fromEntries(calls[0].url.searchParams),{shortcode_source:'github'});
			assert.deepEqual(Object.fromEntries(calls[1].url.searchParams),{q:'face',category:'Smileys & Emotion',max_version:'18.0',include_skin_tones:'false',offset:'0'});
			assert.deepEqual(Object.fromEntries(calls[2].url.searchParams),{include_skin_tones:'false',offset:'2'});
			assert.equal(calls[3].url.pathname,'/emoji/categories');
			assert.equal(calls[4].url.pathname,'/emoji/parse');
			assert.deepEqual(Object.fromEntries(calls[4].url.searchParams),{lang:'fr',deep:'true'});
			assert.equal(calls[4].init.method,'POST');
			assert.deepEqual(JSON.parse(calls[4].init.body),{text:'x 👍🏿 👍🏿'});
			assert.equal(new Headers(calls[4].init.headers).get('Parse-Version'),'2.0.0');
			assert.equal(calls.length,5);
		});
	}
}


for(const transport of ['stdio','http']) for(const mode of ['full','compact']) {
 test(`one-read metadata and catalog URL on ${transport}/${mode}`,async t=>{
  const actual=JSON.parse(await readFile(new URL('./fixtures/emoji-artwork.json',import.meta.url),'utf8')).metadata;
  const calls=[];t.mock.method(globalThis,'fetch',async(input)=>{const url=new URL(String(input));calls.push(url);assert.equal(url.pathname,'/emoji/metadata');return Response.json(actual);});
  const rpc=await connect('test',transport,{mode});t.after(()=>rpc.close());const call=(name,args)=>mode==='compact'?rpc.call('lookup',{operation:name,arguments:args}):rpc.call(name,args);
  assert.deepEqual(body(await call('emoji_metadata',{})),actual);
  const result=body(await call('emoji_catalog',{profile:'compact'}));assert.deepEqual(result.metadata,actual);assert.equal(new URL(result.download_url).searchParams.get('profile'),'compact');assert.equal(calls.length,2);
 });
 test(`private conversion on ${transport}/${mode}`,async t=>{
  const calls=[];t.mock.method(globalThis,'fetch',async(input,init)=>{calls.push({url:new URL(String(input)),init});return Response.json({text:'🚀',unresolved:[]});});
  const rpc=await connect('test',transport,{mode});t.after(()=>rpc.close());const call=(name,args)=>mode==='compact'?rpc.call('lookup',{operation:name,arguments:args}):rpc.call(name,args);
  assert.equal(body(await call('emoji_convert',{text:':rocket:',direction:'to_emoji',shortcode_source:'github'})).text,"🚀");
  assert.equal(calls[0].init.method,'POST');assert.deepEqual(JSON.parse(calls[0].init.body),{text:':rocket:'});
  assert.equal((await call('emoji_convert',{text:'x'.repeat(16001),direction:'to_emoji',shortcode_source:'github'})).result.isError,true);assert.equal(calls.length,1);
 });
}
