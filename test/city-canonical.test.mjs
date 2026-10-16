import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {connect,body} from './helpers.mjs';

for(const transport of ['stdio','http'])for(const mode of ['full','compact']) {
  test(`City canonical traversal and distance on ${transport}/${mode}`,async t=>{
    const calls=[];let payload;
    t.mock.method(globalThis,'fetch',async(input,init)=>{calls.push({url:new URL(String(input)),init});return new Response(JSON.stringify(payload));});
    const rpc=await connect('fixture',transport,{mode});t.after(()=>rpc.close());
    if(mode==='full'){const listed=await rpc.request('tools/list',{});for(const tool of listed.result.tools.filter(tool=>tool.name.startsWith('city'))){assert.equal(Object.hasOwn(tool.inputSchema.properties||{},'fields'),false,tool.name);}}
    const id='city_7aj899nvwyku';
    const resource={id,object:'city',name:'Vienna',name_local:'Wien',match:{type:'fuzzy',source:'name',value:'Vienna',language:null,edit_distance:1},future:true};
    const list={object:'list',data:[resource],has_more:false,url:'/city',next_cursor:null};
    const relations={...list,city_id:id,relationship:'children',coverage:'partial'};
    const distance={object:'city_distance',from:id,to:id,distance:0,distance_mi:0,method:'great_circle'};
    for(const [operation,args,path,query,result] of [
      ['city',{name:'Vienna',format:'resource',},'/city/Vienna',{format:'resource',},resource],
      ['city_id',{id,format:'resource',},`/city/id/${id}`,{format:'resource',},resource],
      ['city_search',{query:'Vi',match:'fuzzy',max_distance:1,format:'list',countries:['AT','CH'],exclude_countries:['JP'],timezones:['Europe/Vienna','Europe/Zurich'],min_elevation:-10,max_elevation:0,min_population:0,sort:'country,-population,name'},'/city/search',{q:'Vi',match:'fuzzy',max_distance:'1',format:'list',countries:'AT,CH',exclude_countries:'JP',timezones:'Europe/Vienna,Europe/Zurich',min_elevation:'-10',max_elevation:'0',min_population:'0',sort:'country,-population,name'},list],
      ['city_nearby',{name:'Vienna',format:'list',},'/city/Vienna/nearby',{format:'list',},list],
      ['city_children',{id,cursor:'opaque+/=',limit:2,deep:true,lang:'de'},`/city/id/${id}/children`,{cursor:'opaque+/=',limit:'2',deep:'true',lang:'de'},relations],
      ['city_ancestors',{id,},`/city/id/${id}/ancestors`,{},{...relations,relationship:'ancestors'}],
      ['city_siblings',{id,hierarchy:true},`/city/id/${id}/siblings`,{hierarchy:'true'},{...relations,relationship:'siblings',parent_id:null}],
      ['city_id',{id,format:'resource',romanized:true},`/city/id/${id}`,{format:'resource',romanized:'true'},{"id":"city_7aj899nvwyku","object":"city","name_romanized":"Kitakyūshū","romanization_language":"ja-Latn"}],
      ['city_distance',{from:id,to:id},`/city/id/${id}/distance/${id}`,{},distance],
    ]) {
      payload=result;
      const answer=mode==='compact'?await rpc.call('lookup',{operation,arguments:args}):await rpc.call(operation,args);
      assert.deepEqual(body(answer),result);assert.equal(calls.at(-1).url.pathname,path);assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams),query);
      assert.equal(new Headers(calls.at(-1).init.headers).get('Parse-Version'),'2.0.0');
    }
    payload={...distance,distance:null,distance_mi:null};
    assert.deepEqual(body(mode==='compact'?await rpc.call('lookup',{operation:'city_distance',arguments:{from:id,to:id}}):await rpc.call('city_distance',{from:id,to:id})),payload);
    const previous=calls.length;
    const invalid={from:'city_invalid',to:id};
    const rejected=mode==='compact'?await rpc.call('lookup',{operation:'city_distance',arguments:invalid}):await rpc.call('city_distance',invalid);
    assert.ok(rejected.error||rejected.result.isError);assert.equal(calls.length,previous);
  });
}

for(const transport of ['stdio','http'])for(const mode of ['full','compact']) {
  test(`City409 candidates and unrelated errors on ${transport}/${mode}`,async t=>{
    const safe={id:'city_7aj899nvwyku',object:'city',name:'Vienna',name_local:'Wien',country:'AT',state:null};
    let status=409,code='ambiguous_city',calls=0;
    t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(JSON.stringify({code,message:'Choose a city',docs:null,request_id:'req_city',candidates:[{...safe,deep:{population:99}},safe,safe]}),{status,headers:{'Retry-After':'60'}});});
    const rpc=await connect('fixture',transport,{mode});t.after(()=>rpc.close());
    for(const pair of [[409,'ambiguous_city'],[409,'conflict'],[400,'ambiguous_city'],[429,'rate_limited']]) {
      [status,code]=pair;
      const args={name:'Vienna',ambiguity:'error'};
      const answer=mode==='compact'?await rpc.call('lookup',{operation:'city',arguments:args}):await rpc.call('city',args);
      assert.equal(answer.result.isError,true);
      const expected={code,message:'Choose a city',docs:null,request_id:'req_city',retry_after:'60'};
      assert.deepEqual(body(answer),status===409&&code==='ambiguous_city'?{...expected,candidates:[safe,safe]}:expected);
    }
    assert.equal(calls,4);
  });
}
