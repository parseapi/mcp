import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';

for (const transport of ['stdio','http']) for (const mode of ['full','compact']) {
	test(`City options and optional parent/population remain usable over ${transport}/${mode}`, async t=>{
		const calls=[];
		const payload={id:'city_222222222222',name:'Fixture',country:'JP',grain:'subdivision',parent:{id:'city_333333333333',name:null,name_local:'市',country:'JP',state:'14',type:'city',grain:'municipality',future:true},deep:{population:0,population_observed_on:'2025-12-31',population_basis:'registered_population'},future:true};
		t.mock.method(globalThis,'fetch',async(input,init)=>{calls.push({url:new URL(String(input)),init});return new Response(JSON.stringify(payload));});
		const rpc=await connect('test',transport,{mode});t.after(()=>rpc.close());
		const common={country:'JP',state:'14',type:'ward',grain:'subdivision',hierarchy:true,deep:true,lang:'ja'};
		for (const [operation,args,path,expected] of [
			['city',{name:'Fixture',...common,aliases:true,ambiguity:'error'},'/city/Fixture',{...common,aliases:true,ambiguity:'error'}],
			['city_id',{id:'city_222222222222',hierarchy:true,deep:true,lang:'ja'},'/city/id/city_222222222222',{hierarchy:true,deep:true,lang:'ja'}],
			['city_search',{query:'Fi',...common,aliases:true,limit:5},'/city',{...common,q:'Fi',aliases:true,limit:5}],
			['city_nearest',{lat:0,lon:0,...common},'/city',{...common,lat:0,lon:0}],
			['city_nearby',{name:'Fixture',...common,aliases:true,ambiguity:'error',radius:10,unit:'km',limit:5},'/city/Fixture/nearby',{...common,aliases:true,ambiguity:'error',radius:10,unit:'km',limit:5}],
		]) {
			const result=mode==='compact'?await rpc.call('lookup',{operation,arguments:args}):await rpc.call(operation,args);
			assert.deepEqual(body(result),payload);
			assert.equal(calls.at(-1).url.pathname,path);
			assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams),Object.fromEntries(Object.entries(expected).map(([k,v])=>[k,String(v)])));
			assert.equal(new Headers(calls.at(-1).init.headers).get('Parse-Version'),'2.0.0');
		}
		const before=calls.length;
		const invalid={name:'Fixture',grain:'city'};
		const rejected=mode==='compact'?await rpc.call('lookup',{operation:'city',arguments:invalid}):await rpc.call('city',invalid);
		assert.ok(rejected.error||rejected.result.isError);
		assert.equal(calls.length,before);
		const basic=mode==='compact'?await rpc.call('lookup',{operation:'city',arguments:{name:'Fixture',hierarchy:false,aliases:false}}):await rpc.call('city',{name:'Fixture',hierarchy:false,aliases:false});
		assert.deepEqual(body(basic),payload);
		assert.equal(calls.at(-1).url.search,'');
	});
}
