import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transform } from 'sucrase';
import { VM } from 'vm2';
async function fixture() {
  const source = await readFile('data/vendor/volcengine.ts', 'utf8');
  const provider: any = {}, calls: any[] = [], configs: any[] = [];
  new VM({ sandbox: {exports:provider, URL, withVolcengineChatCompatibility:(model:any)=>model, fetch:async (url:any, options:any)=>{calls.push({url,...options,parsed:options?.body && JSON.parse(options.body)});return new Response('{}');}, createOpenAICompatible:(config:any)=>{configs.push(config);return {chatModel:(modelName:string)=>({modelName,fetch:config.fetch})};}}}).run(transform(source,{transforms:['typescript']}).code);
  provider.vendor.inputValues={apiKey:' Bearer unit-secret ',baseUrl:' https://ark.cn-beijing.volces.com/api/v3/ '};
  return {provider,calls,configs};
}
test('Volcengine catalog keeps latest product lines from every standard language provider and no media',async()=>{
 const {provider}=await fixture();
 assert.equal(provider.vendor.id,'volcengine');
 assert.equal(provider.vendor.models.length,11);
 assert.deepEqual(new Set(provider.vendor.models.map((m:any)=>m.provider)),new Set(['字节跳动','DeepSeek','智谱AI']));
 assert(provider.vendor.models.every((m:any)=>m.type==='text'));
 assert(!provider.vendor.models.some((m:any)=>/seed-1-|glm-4|deepseek-v3|260425|lite-260215|mini-260215/.test(m.modelName)));
 await assert.rejects(provider.imageRequest(),/仅保留语言模型/);
});
test('every catalog model supports the application thinking switch and each level without contradictory parameters',async()=>{
 const {provider,calls,configs}=await fixture();
 for(const model of provider.vendor.models) for(const think of [false,true]) for(const level of [0,1,2,3]){
   const runtime=provider.textRequest(model,think,level);
   const body={model:model.modelName,messages:[{role:'user',content:'hi'}],stream:true,max_tokens:768,thinking:{type:'auto'},reasoning_effort:'minimal',tools:[{type:'function',function:{name:'x',parameters:{type:'object',properties:{}}}}]};
   const ctrl=new AbortController();
   await runtime.fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions',{method:'POST',body:JSON.stringify(body),signal:ctrl.signal});
   const call=calls.at(-1),parsed=call.parsed;
   assert.equal(call.signal,ctrl.signal);
   assert.equal(configs.at(-1).baseURL,'https://ark.cn-beijing.volces.com/api/v3');
   assert.equal(configs.at(-1).apiKey,'unit-secret');assert.equal(configs.at(-1).includeUsage,true);
   assert.deepEqual(parsed.messages,body.messages);assert.deepEqual(parsed.tools,body.tools);assert.equal(parsed.stream,true);
   assert.equal(parsed.max_completion_tokens,768);assert.equal(parsed.max_tokens,undefined);
   assert.equal(parsed.thinking.type,think || model.thinkingMode==='required'?'enabled':'disabled');
   if(parsed.thinking.type==='disabled') assert.equal(parsed.reasoning_effort,undefined);
   else assert(['low','medium','high','max'].includes(parsed.reasoning_effort));
   if(model.thinkingMode==='required'&&!think)assert.equal(parsed.reasoning_effort,'low');
 }
});
test('output budget tightens to the declared limit and explicit completion budget is retained',async()=>{
 const {provider,calls}=await fixture();const m=provider.vendor.models[6],runtime=provider.textRequest(m,true,2);
 await runtime.fetch('/chat/completions',{body:JSON.stringify({max_tokens:99,max_completion_tokens:327,messages:[]})});
 assert.equal(calls.at(-1).parsed.max_completion_tokens,327);
 await runtime.fetch('/chat/completions',{body:JSON.stringify({max_tokens:999999,messages:[]})});
 assert.equal(calls.at(-1).parsed.max_completion_tokens,32000);
});
test('invalid credentials and base addresses fail before dispatch',async()=>{
 const {provider}=await fixture();const m=provider.vendor.models[0];
 for(const baseUrl of ['bad','https://ark.example/api/v1','https://secret:pw@ark.example/api/v3','https://ark.example/api/v3?key=secret']){
 provider.vendor.inputValues.baseUrl=baseUrl; assert.throws(()=>provider.textRequest(m,false,0),/请求地址/);
 }
 provider.vendor.inputValues.apiKey=' Bearer ';assert.throws(()=>provider.textRequest(m,false,0),/API Key/);
});
