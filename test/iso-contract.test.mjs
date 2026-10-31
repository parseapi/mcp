import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';
const cases = JSON.parse(readFileSync(new URL('./fixtures/iso-contract.json', import.meta.url), 'utf8')).filter(item => !item.operation.startsWith('currency'));
for (const transport of ['stdio', 'http']) for (const mode of ['full', 'compact']) {
 test(`ISO response contracts remain raw over ${transport}/${mode}`, async t => {
  let sample; const calls=[];
  t.mock.method(globalThis,'fetch',async input => { calls.push(new URL(String(input)));return Response.json(sample.body); });
  const rpc=await connect('fixture',transport,{mode});t.after(()=>rpc.close());
  for (sample of cases) {
   const args={code:sample.code,deep:sample.deep,...(sample.country ? {country:sample.country} : {})};
   const response=mode==='compact' ? await rpc.call('lookup',{operation:sample.operation,arguments:args}) : await rpc.call(sample.operation,args);
   assert.deepEqual(body(response),sample.body);
  }
  assert.equal(calls.length,cases.length);
 });
}
