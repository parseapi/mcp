import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect, body } from './helpers.mjs';
const fixtures=['country-corrected.json','country-aq.json','country-de.json'].map(name=>JSON.parse(readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8')));
for(const transport of ['stdio','http'])for(const mode of ['full','compact'])test(`Country context and nullable facts survive ${transport}/${mode}`,async t=>{
 let calls=0,payload;
 t.mock.method(globalThis,'fetch',async(input,init)=>{calls++;assert.equal(new URL(String(input)).pathname,'/country/'+payload.country);assert.equal(new Headers(init.headers).get('Parse-Version'),'2.0.0');return new Response(JSON.stringify(payload));});
 const rpc=await connect('test',transport,{mode});t.after(()=>rpc.close());
 for(const full of fixtures){payload=full;const args={code:full.country,deep:true};const result=mode==='compact'?await rpc.call('lookup',{operation:'country',arguments:args}):await rpc.call('country',args);assert.deepEqual(body(result),full);assert.equal(Object.hasOwn(full,'full_name'),false);assert.equal(Object.keys(full).at(-1),'deep');for(const key of ['iso3','numeric','name_full','full_name','demonym','region','subregion','capital','capital_lat','capital_lon','borders','blocs'])assert.equal(Object.hasOwn(full.deep,key),false);assert.equal(Object.hasOwn(full,'population'),false);assert.equal(Object.hasOwn(full,'area'),false);if(full.country==='AQ'){assert.equal(full.languages,null);assert.deepEqual([full.currency,full.currency_name,full.currency_symbol],[null,null,null]);assert.equal(full.deep.population,0);}else if(full.country==='US'){assert.equal(full.name_full,'United States of America');assert.equal(full.demonym,'American');}else{assert.deepEqual(full.deep.tax,{name:'VAT',rate:19});}assert.equal(Object.hasOwn(full,'emoji'),false);assert.equal(typeof full.capital,'object');for(const key of ['capital_lat','capital_lon'])assert.equal(Object.hasOwn(full,key),false);for(const key of ['tax_rate','tax_id_format','tax_id_regex'])assert.equal(Object.hasOwn(full.deep,key),false);}
 const {deep:_,...core}=fixtures[0];
 for(const bodyValue of [core,{...core,deep:{}}]){payload=bodyValue;const args={code:payload.country,...(Object.hasOwn(payload,'deep')?{deep:true}:{})};const result=mode==='compact'?await rpc.call('lookup',{operation:'country',arguments:args}):await rpc.call('country',args);assert.deepEqual(body(result),bodyValue);}
 assert.equal(calls,5);
});
