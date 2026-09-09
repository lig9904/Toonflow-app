import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { addProductionStoryboards, readProductionFlow, saveProductionPlanning } from "../src/services/productionFlow";
import { ensureProductionStateSchema, ProductionStateService } from "../src/services/productionState";
import { createOrUpdateDerivedAsset, deleteDerivedAsset, ensureProductionAssetSchema } from "../src/services/productionAssets";
import { prepareStoryboardImages, type ProductionImageRuntime } from "../src/services/productionImages";
import { ensureAgentGatewaySchema, createAgentGateway } from "../src/services/agentGateway";
import express from "express";

const options={skip:!process.env.TOONFLOW_TEST_DATABASE_URL};
async function fixture(){
 const f=await createPostgresFixture();await migratePostgresFixture(f.db);await ensureProductionStateSchema(f.db);await ensureProductionAssetSchema(f.db);await ensureAgentGatewaySchema(f.db);
 const [projectId]=await insertRowsReturningIds(f.db,"o_project",{name:"PG project",userId:1,imageModel:"mock:model",imageQuality:"1K",videoRatio:"16:9"});
 const [scriptId]=await insertRowsReturningIds(f.db,"o_script",{projectId,name:"Episode",content:"PG relational script"});
 const [parentId]=await insertRowsReturningIds(f.db,"o_assets",{projectId,name:"Parent",type:"role",describe:"Parent detail"});
 await f.db("o_scriptAssets").insert({scriptId,assetId:parentId});
 return {...f,projectId,scriptId,parentId};
}
test("PostgreSQL production flow keeps ordered references and numeric fractional track duration",options,async()=>{
 const f=await fixture();try{
 const child=await createOrUpdateDerivedAsset(f.db,{projectId:f.projectId,scriptId:f.scriptId,parentAssetId:f.parentId,name:"Child",description:"child"});
 const ids=await addProductionStoryboards(f.db,f.projectId,f.scriptId,[{prompt:"PG shot",duration:2.5,track:"A",videoDesc:"test",shouldGenerateImage:0,associateAssetsIds:[child.id,f.parentId]}]);
 const flow=await readProductionFlow(f.db,f.projectId,f.scriptId,async path=>path);
 assert.equal(flow.script,"PG relational script");assert.deepEqual(flow.storyboard[0].associateAssetsIds,[child.id,f.parentId]);assert.equal(flow.storyboard[0].duration,2.5);
 assert.equal(Number((await f.db("o_videoTrack").first()).duration),2.5);
 const state=await new ProductionStateService(f.db).getStoryboardState(f.projectId,ids[0]);
 await new ProductionStateService(f.db).acquireLock({projectId:f.projectId,storyboardId:ids[0],expectedVersion:state.state.version,actor:{id:"human:1",kind:"human"}});
 await assert.rejects(deleteDerivedAsset(f.db,{projectId:f.projectId,scriptId:f.scriptId,parentAssetId:f.parentId,id:child.id,expectedVersion:1}));
 assert(await f.db("o_assets").where({id:child.id}).first());
 }finally{await f.destroy();}
});
test("PostgreSQL concurrent initial planning saves have exactly one winner",options,async()=>{
 const f=await fixture();try{
 const results=await Promise.allSettled([saveProductionPlanning(f.db,f.projectId,f.scriptId,0,{scriptPlan:"one",storyboardTable:""}),saveProductionPlanning(f.db,f.projectId,f.scriptId,0,{scriptPlan:"two",storyboardTable:""})]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal((await f.db("o_agentWorkData").where({projectId:f.projectId})).length,1);
 }finally{await f.destroy();}
});
test("PostgreSQL prepare does not invoke model, claimed generation then saves result",options,async()=>{
 const f=await fixture();try{
 const ids=await addProductionStoryboards(f.db,f.projectId,f.scriptId,[{prompt:"generate",duration:3,track:"A",videoDesc:"fixture",shouldGenerateImage:1,associateAssetsIds:[]}]);
 let calls=0;
 const runtime:ProductionImageRuntime={getArtPrompt:()=>"",generatePrompt:async()=>"",getImageBase64:async()=>"",getSmallImageUrl:async path=>path,uuid:()=>"pg-fixture",generateImage:async()=>{calls++;return{save:async()=>{}}}};
 const prepared=await prepareStoryboardImages(f.db,{projectId:f.projectId,scriptId:f.scriptId,storyboardIds:ids,runtime});assert.equal(calls,0);
 const results=await prepared.run();assert.equal(calls,1);assert.equal(results[0].state,"已完成");assert.equal((await f.db("o_storyboard").where({id:ids[0]}).first()).state,"已完成");
 }finally{await f.destroy();}
});
test("PostgreSQL scoped agent HTTP write and audit commit once across retries",options,async()=>{
 const f=await fixture();let server:ReturnType<ReturnType<typeof express>["listen"]>|undefined;
 try{
 const ids=await addProductionStoryboards(f.db,f.projectId,f.scriptId,[{prompt:"before",duration:1,track:"A",videoDesc:"",shouldGenerateImage:0,associateAssetsIds:[]}]);
 const token="pg-agent-fixture-key-with-32-characters";const app=express();app.use(express.json());app.use(createAgentGateway(f.db,{token,userId:1,projectIds:[f.projectId],allowStoryboardWrite:true},async path=>path));
 await new Promise<void>(resolve=>{server=app.listen(0,"127.0.0.1",()=>resolve());});const address=server!.address();assert(address&&typeof address!=="string");
 const input={projectId:f.projectId,storyboardId:ids[0],expectedVersion:0,prompt:"via PG",videoDesc:"",reason:"PG migration check",idempotencyKey:"pg-idempotency-123456"};
 const post=async()=>{const r=await fetch(`http://127.0.0.1:${address.port}/storyboard/update`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(input)});return{status:r.status,body:await r.json() as any};};
 const result=await post();assert.equal(result.status,200,JSON.stringify(result.body));assert.equal((await post()).body.data.replayed,true);assert.equal((await f.db("ext_agent_mutations")).length,1);
 }finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));await f.destroy();}
});
