import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connect,body} from './helpers.mjs';

for(const mode of ['full','compact'])test(`${mode} bounded task tools preserve IDs, auth, paid result status and unknowns`,async t=>{
	const calls=[];
	t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push({url:new URL(String(url)),init});return new Response(JSON.stringify({status_code:503,result:{valid:null},receipt:{additional_cost_usd:'0.0000'}}));});
	const rpc=await connect('fixture','http',{mode});t.after(()=>rpc.close());
	const id=`task_${'b'.repeat(40)}`;
	const result=await rpc.call('task_lookup',{task_id:id,request_id:'stable-id',operation:'email',value:'person@example.test',deep:true});
	assert.equal(body(result).status_code,503);assert.equal(body(result).result.valid,null);
	assert.equal(calls.length,1);assert.equal(calls[0].url.pathname,`/task/${id}/lookup`);
	assert.equal(new Headers(calls[0].init.headers).get('Idempotency-Key'),'stable-id');
	assert.equal(new Headers(calls[0].init.headers).get('X-API-Key'),'fixture');
	assert.deepEqual(JSON.parse(calls[0].init.body),{operation:'email',value:'person@example.test',deep:true});
	const tools=(await rpc.request('tools/list',{})).result.tools;
	assert.equal(tools.find(x=>x.name==='task_lookup').annotations.idempotentHint,true);
	assert.equal(tools.find(x=>x.name==='task_create').annotations.readOnlyHint,false);
	await rpc.call('task_create',{operations:[{operation:'vat',count:2,deep:true}],budget_usd:'0.50',request_id:'create'});
	assert.equal(calls.length,2);assert.equal(calls[1].url.pathname,'/task');
	assert.equal(JSON.parse(calls[1].init.body).request_id,undefined);
	const invalid=await rpc.call('task_lookup',{task_id:id,request_id:'invalid',operation:'email',value:'x',deep:'true'});assert.equal(invalid.result.isError,true);assert.equal(calls.length,2);
});
test('task tools with no key do not start work',async t=>{
	t.mock.method(globalThis,'fetch',()=>assert.fail('keyless must not dispatch'));
	const rpc=await connect(null,'stdio');t.after(()=>rpc.close());
	assert.equal(body(await rpc.call('task_create',{operations:[{operation:'email',count:1}],budget_usd:'0',request_id:'id'})).code,'invalid_api_key');
});
