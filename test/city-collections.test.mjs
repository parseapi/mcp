import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';

for (const transport of ['stdio','http']) for (const mode of ['full','compact']) {
	test(`City collections preserve filters, paging and response values over ${transport}/${mode}`,async t=>{
		const calls=[];
		let payload={cities:[{name:'Fixture',country:'AT',grain:'future-grain',deep:{population:0}}],next_cursor:'opaque+/=?&',future:true};
		t.mock.method(globalThis,'fetch',async(input,init)=>{calls.push({url:new URL(String(input)),init});return new Response(JSON.stringify(payload));});
		const rpc=await connect('test',transport,{mode});t.after(()=>rpc.close());
		const common={country:'AT',state:'9',type:'city',grain:'municipality',hierarchy:true,min_population:0,max_population:Number.MAX_SAFE_INTEGER,timezone:'Europe/Vienna',bbox:'170,-10,-170,10',sort:'population',order:'desc',cursor:'opaque+/=?&',limit:5,deep:true,lang:'de'};
		for (const [operation,args,path,expected] of [
			['city_list',common,'/city',{...common,browse:true,format:'list'}],
			['city_search',{query:'Fi',...common,aliases:true,page:true},'/city',{...common,q:'Fi',aliases:true,page:true}],
			['city_nearby',{name:'Fixture',...common,aliases:true,ambiguity:'error',page:true,radius:5,unit:'mi'},'/city/Fixture/nearby',{...common,aliases:true,ambiguity:'error',page:true,radius:5,unit:'mi'}],
			['city_nearby_coordinates',{lat:0,lon:0,...common,radius:5,unit:'mi'},'/city',{...common,lat:0,lon:0,nearby:true,radius:5,unit:'mi',format:'list'}],
		]) {
			if(operation==='city_nearby_coordinates')payload={latitude:0,longitude:0,radius:5,unit:'mi',nearby:[{name:'Fixture',country:'AT',distance:0,distance_mi:0,grain:'future-grain',deep:{population:0}}],next_cursor:null,future:true};
			const result=mode==='compact'?await rpc.call('lookup',{operation,arguments:args}):await rpc.call(operation,args);
			assert.deepEqual(body(result),payload);
			assert.equal(calls.at(-1).url.pathname,path);
			assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams),Object.fromEntries(Object.entries(expected).map(([k,v])=>[k,String(v)])));
			assert.equal(new Headers(calls.at(-1).init.headers).get('Parse-Version'),'2.0.0');
		}
		for(const [operation,args,expected] of [
			['city_list',{}, {browse:'true',format:'list'}],
			['city_nearby_coordinates',{lat:0,lon:0},{lat:'0',lon:'0',nearby:'true',format:'list'}],
			['city_search',{query:'Fi',page:false},{q:'Fi'}],
			['city_nearby',{name:'Fixture',page:false},{}],
		]) {
			const result=mode==='compact'?await rpc.call('lookup',{operation,arguments:args}):await rpc.call(operation,args);
			assert.deepEqual(body(result),payload);
			assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams),expected);
		}
		for(const [operation,args] of [
			['city_list',{sort:'distance'}],['city_search',{query:'Fi',min_population:-1}],
			['city_nearby_coordinates',{lat:91,lon:0}],['city_nearby_coordinates',{lat:0}],
			['city_nearby',{name:'Fixture',sort:'relevance'}],
		]) {
			const before=calls.length;
			const result=mode==='compact'?await rpc.call('lookup',{operation,arguments:args}):await rpc.call(operation,args);
			assert.ok(result.error||result.result.isError);
			assert.equal(calls.length,before);
		}
	});
}
