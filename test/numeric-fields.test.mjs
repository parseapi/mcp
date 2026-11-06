import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';

for (const transport of ['stdio','http']) for (const mode of ['full','compact']) {
  test(`seven numeric fields preserve values over ${transport}/${mode}`, async t => {
    const country={"country":"US","deep":{"gdp_usd":30769700000000,"gdp_per_capita_usd":90026.5163005744,"population_growth_percent":-0.25,"urban_population_percent":0,"internet_users_percent":null}};
    const weather={"deep":{"minutes":[{"at":"2026-10-27T12:00:00Z","precipitation_rate":1.8,"precipitation_rate_in":0.071,"type":"rain"},{"at":"2026-10-27T12:01:00Z","precipitation_rate":0,"precipitation_rate_in":0},{"at":"2026-10-27T12:02:00Z","precipitation_rate":null,"precipitation_rate_in":null}],"history":{"precipitation":12.3,"precipitation_in":0.484}}};
    t.mock.method(globalThis,'fetch',async input => new Response(JSON.stringify(new URL(String(input)).pathname.startsWith('/country/') ? country : weather)));
    const rpc=await connect('fixture',transport,{mode});t.after(()=>rpc.close());
    for (const [operation,args,expected] of [
      ['country',{code:'US',deep:true},country], ['weather',{lat:0,lon:0,deep:true},weather],
    ]) {
      const response=mode==='compact' ? await rpc.call('lookup',{operation,arguments:args}) : await rpc.call(operation,args);
      assert.deepEqual(body(response),expected);
    }
  });
}
