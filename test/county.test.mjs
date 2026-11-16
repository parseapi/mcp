import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';

for (const transport of ['stdio', 'http']) for (const mode of ['full', 'compact']) {
 test(`County canonical and historical tool results: ${transport}/${mode}`, async t => {
  const calls=[];
  const county={county:'E09000033',iso_code:'GB-WSM',name:'City of Westminster',type:'district',population:0,property_tax:null};
  t.mock.method(globalThis,'fetch',async(input,init)=>{
   const url=new URL(String(input));calls.push(url.pathname);
   assert.equal(new Headers(init?.headers).get('X-API-Version'),'2.2.0');
   return Response.json(url.pathname.endsWith('/counties')?{state:'ENG',country:'GB',counties:[county]}:county);
  });
  const rpc=await connect('fixture',transport,{mode});t.after(()=>rpc.close());
  const run=(operation,args)=>mode==='compact'?rpc.call('lookup',{operation,arguments:args}):rpc.call(operation,args);
  assert.deepEqual(body(await run('county',{code:'Westminster',country:'GB'})),county);
  const historical={district:'E09000033',name:'City of Westminster',type:'district',population:0,property_tax:null};
  assert.deepEqual(body(await run('district',{code:'Westminster',country:'GB'})),historical);
  assert.deepEqual(body(await run('state_counties',{code:'ENG',country:'GB'})),{state:'ENG',country:'GB',counties:[county]});
  assert.deepEqual(body(await run('state_districts',{code:'ENG',country:'GB'})),{state:'ENG',country:'GB',districts:[historical]});
  county.iso_code=null;
  assert.deepEqual(body(await run('county',{code:'Westminster',country:'GB'})),county);
  assert.deepEqual(body(await run('district',{code:'Westminster',country:'GB'})),historical);
  assert.deepEqual(calls,['/county/Westminster','/county/Westminster','/state/ENG/counties','/state/ENG/counties','/county/Westminster','/county/Westminster']);
 });
}
