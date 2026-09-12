import test from 'node:test';
import assert from 'node:assert/strict';
import {createPostgresFixture,migratePostgresFixture} from '../src/lib/postgresTest';
import {insertRowsReturningIds} from '../src/lib/insertRows';
import {BuiltinAgentRuntime,ensureBuiltinAgentRuntimeSchema} from '../src/services/builtinAgentRuntime';
import {ensureAssetWorkspaceSchema,updateAsset} from '../src/services/assetWorkspace';
import {ensureManualPolishSchema,initializeManualPolish,createManualPolishExecutor,reconcileManualPolishStates} from '../src/services/builtinAgent/manualAssetPolish';
const options={skip:!process.env.TOONFLOW_TEST_DATABASE_URL};
test('manual polish freezes identity/style rules, saves by version, and never overwrites concurrent human content',options,async()=>{
 const f=await createPostgresFixture();try{
  await migratePostgresFixture(f.db);await ensureAssetWorkspaceSchema(f.db);await ensureBuiltinAgentRuntimeSchema(f.db);await ensureManualPolishSchema(f.db);
  const [projectId]=await insertRowsReturningIds(f.db,'o_project',{userId:1,name:'fixture'});
  const [assetId]=await insertRowsReturningIds(f.db,'o_assets',{projectId,name:'九九',type:'role',describe:'幼态神兽',prompt:'old'});
  let calls=0,editDuringCall=false;
  const worker=new BuiltinAgentRuntime({db:f.db,authorize:async()=>undefined,beforeCreate:(run,trx)=>initializeManualPolish(trx,run),execute:createManualPolishExecutor({db:f.db,model:{async generate(r){calls++;assert.match(r.system,/物种/);assert.match(r.system,/FROZEN_STYLE/);if(editDuringCall)await updateAsset(f.db,{id:assetId,projectId,expectedVersion:1,idempotencyKey:'human-edit-polish',name:'九九',describe:'人工新设定',prompt:'HUMAN_PROMPT'},{kind:'human',id:'human:2'});return {value:r.schema.parse({prompt:'神兽保持非人类形态'}),outputTokens:42};}}})});
  const make=(key:string,version:number)=>({agentType:'productionAgent' as const,projectId,scriptId:null,requestedBy:1,prompt:'polish',idempotencyKey:key,intent:{phase:'polishAssets',context:{projectId,items:[{assetsId:assetId,expectedVersion:version,name:'九九',describe:'幼态神兽',type:'role',system:'FROZEN_STYLE'}],otherTextPrompt:''}},limits:{maxModelCalls:1,maxToolSteps:6,maxOutputTokens:64000,maxImageGenerations:0,maxVideoGenerations:0}});
  const first=await worker.create(make('polish-first',0));await worker.runOnce();assert.equal((await worker.get(first.run.id)).status,'succeeded');assert.equal(calls,1);assert.equal((await f.db('o_assets').where({id:assetId}).first()).prompt,'神兽保持非人类形态');
  editDuringCall=true;const second=await worker.create(make('polish-second',1));await worker.runOnce();assert.equal(((await worker.get(second.run.id)).result as {outcome?:string})?.outcome,'partial');assert.equal((await f.db('o_assets').where({id:assetId}).first()).prompt,'HUMAN_PROMPT');
  const third=await worker.create(make('polish-cancel',2));await worker.control(third.run.id,third.run.version,'cancel','test',1);await reconcileManualPolishStates(f.db,[assetId]);assert.equal((await f.db('o_assets').where({id:assetId}).first()).promptState,'生成失败');assert.equal(calls,2);await worker.stop();
 }finally{await f.destroy();}
});

import {assetPromptSystem,requestsSingleAssetImage,assertSingleAssetImage} from '../src/lib/creativePromptPolicy';
test('single-image requests override layout examples and cannot save a positive multi-view instruction',()=>{
 assert.equal(requestsSingleAssetImage('角色只展示单个完整神兽，不多视图'),true);
 assert.equal(requestsSingleAssetImage('制作标准四视图'),false);
 assert.match(assetPromptSystem('四视图是模板默认',true),/本次版式已明确为单幅/);
 assert.throws(()=>assertSingleAssetImage('标准四视图，正侧背面拼版'),/未保存/);
 assert.doesNotThrow(()=>assertSingleAssetImage('单幅角色图，不要四视图，不做拼版。'));
});
