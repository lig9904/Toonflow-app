import test from 'node:test';
import assert from 'node:assert/strict';
import {createPostgresFixture,migratePostgresFixture} from '../src/lib/postgresTest';
import {insertRowsReturningIds} from '../src/lib/insertRows';
import {BuiltinAgentRuntime,ensureBuiltinAgentRuntimeSchema} from '../src/services/builtinAgentRuntime';
import {ensureManualExtractionSchema,initializeManualExtraction,createManualAssetExtractionExecutor,reconcileManualExtractionStates} from '../src/services/builtinAgent/manualAssetExtraction';
import {ensureAssetExtractionWorkspaceSchema} from '../src/services/assetExtractionWorkspace';
const options={skip:!process.env.TOONFLOW_TEST_DATABASE_URL};
test('manual extraction uses real IDs for same-named roots, preserves derived identity, freezes prompt and reconciles cancellation',options,async()=>{
 const f=await createPostgresFixture();try{
  await migratePostgresFixture(f.db);await ensureBuiltinAgentRuntimeSchema(f.db);await ensureManualExtractionSchema(f.db);await ensureAssetExtractionWorkspaceSchema(f.db);
  const [projectId]=await insertRowsReturningIds(f.db,'o_project',{userId:1,name:'fixture'});
  const [scriptId]=await insertRowsReturningIds(f.db,'o_script',{projectId,name:'fixture',content:'九九（神兽）在海边。'});
  const [roleId,sceneId]=await insertRowsReturningIds(f.db,'o_assets',[{projectId,name:'九九',type:'role',describe:'神兽'},{projectId,name:'九九',type:'scene',describe:'海岸'}]);
  const [derivedId]=await insertRowsReturningIds(f.db,'o_assets',{projectId,name:'九九',type:'role',assetsId:roleId,describe:'受伤形态'});
  let calls=0;
  const executor=createManualAssetExtractionExecutor({db:f.db,model:{async generate(req){calls++;assert.match(req.system,/FROZEN_RULE/);assert.equal(req.schema.safeParse({roles:[],scenes:[],props:[],summary:"no bindings"}).success,false);assert.equal(req.schema.safeParse({roles:[],scenes:[],props:[],bindings:[],summary:"missing selected episode"}).success,false);const input=req.input as any;assert.ok(input.existingAssets.some((a:any)=>a.id===roleId));assert.ok(input.existingAssets.some((a:any)=>a.id===sceneId));assert.ok(!input.existingAssets.some((a:any)=>a.id===derivedId));return {value:req.schema.parse({roles:[{action:'reuse',assetId:roleId,expectedVersion:0}],scenes:[],props:[],bindings:[{scriptId,assets:[{kind:'existing',assetId:roleId}]}],summary:'done'}),outputTokens:30};}}});
  const worker=new BuiltinAgentRuntime({db:f.db,authorize:async()=>undefined,beforeCreate:(run,trx)=>initializeManualExtraction(trx,run),execute:executor});
  const input={agentType:'scriptAgent' as const,projectId,scriptId:null,requestedBy:1,idempotencyKey:'manual-assets-test-1',prompt:'提取素材',intent:{phase:'extractAssets',context:{projectId,sourceScripts:[{id:scriptId,expectedVersion:0}],instructions:'FROZEN_RULE'}},limits:{maxModelCalls:2,maxToolSteps:12,maxOutputTokens:64000,maxImageGenerations:0,maxVideoGenerations:0}};
  const {run}=await worker.create(input);await f.db('o_prompt').where({type:'scriptAssetExtraction'}).update({useData:'NEW_RULE'});await worker.runOnce();
  assert.equal((await worker.get(run.id)).status,'succeeded');assert.equal(calls,1);assert.deepEqual((await f.db('o_scriptAssets').where({scriptId})).map(x=>Number(x.assetId)),[roleId]);
  assert.equal((await f.db('o_script').where({id:scriptId}).first()).extractState,1);assert.equal((await f.db('o_assets').where({id:derivedId}).first()).describe,'受伤形态');
  const [secondId]=await insertRowsReturningIds(f.db,'o_script',{projectId,name:'second',content:'海岸。'});
  const pending=await worker.create({...input,idempotencyKey:'manual-assets-test-2',intent:{phase:'extractAssets',context:{projectId,sourceScripts:[{id:secondId,expectedVersion:0}],instructions:'FROZEN_RULE'}}});
  await worker.control(pending.run.id,pending.run.version,'cancel','cancel test',1);await reconcileManualExtractionStates(f.db,[secondId]);
  assert.equal((await f.db('o_script').where({id:secondId}).first()).extractState,-1);assert.equal(calls,1);await worker.stop();
 }finally{await f.destroy();}
});
