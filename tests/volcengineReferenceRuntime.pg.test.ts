import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPostgresFixture, migratePostgresFixture } from '../src/lib/postgresTest';
import { insertRowsReturningIds } from '../src/lib/insertRows';
import { ensureCreativeWorkspaceSchema } from '../src/services/creativeWorkspace';
import { ensureProductionStateSchema } from '../src/services/productionState';
import { replaceVolcengineReferenceBindings, VolcengineTrustedAssetClient } from '../src/services/volcengineTrustedAssets';
import { loadOwnedVideoReferences } from '../src/services/videoJobs/request';
import { revalidateTrustedVideoReferences } from '../src/services/volcengineReferenceRuntime';
import { currentPromptReferences } from '../src/services/videoPromptReview';

const options={skip:!process.env.TOONFLOW_TEST_DATABASE_URL};
test('trusted references replace exactly one local input, invalidate prompt snapshots, and reject stale submissions',options,async(t)=>{
 const f=await createPostgresFixture();
 try {
  await migratePostgresFixture(f.db);await ensureCreativeWorkspaceSchema(f.db);await ensureProductionStateSchema(f.db);
  const [projectId]=await insertRowsReturningIds(f.db,'o_project',{userId:1,name:'trusted runtime'});
  const [scriptId]=await insertRowsReturningIds(f.db,'o_script',{projectId,name:'episode'});
  const [imageId]=await insertRowsReturningIds(f.db,'o_image',{filePath:'/test/actor.png',type:'role',state:'已完成'});
  const [assetId]=await insertRowsReturningIds(f.db,'o_assets',{projectId,name:'actor',type:'role',imageId});
  await f.db('o_scriptAssets').insert({scriptId,assetId});
  await f.db('o_vendorConfig').insert({id:'volcengineSd2',enable:1,inputValues:JSON.stringify({ak:'AK_TEST_ONLY',sk:'SK_TEST_ONLY'})}).onConflict('id').merge();
  const actions:string[]=[];
  const remote=async(input:any)=>{
   const action=new URL(String(input)).searchParams.get('Action')!;actions.push(action);
   return new Response(JSON.stringify({Result:action==='GetAssetGroup'?{Id:'group-1',GroupType:'AIGC',ProjectName:'default'}:{Id:'asset-1',GroupId:'group-1',AssetType:'Image',Status:'Active',ProjectName:'default'}}),{status:200});
  };
  t.mock.method(globalThis,'fetch',remote);
  const client=new VolcengineTrustedAssetClient({credentials:{accessKeyId:'AK_TEST_ONLY',secretAccessKey:'SK_TEST_ONLY'},fetch:remote});
  let data='data:image/png;base64,YQ==';
  const toBase64=async()=>data;
  const hash=()=>createHash('sha256').update(data).digest('hex');
  const info=[{id:assetId,sources:'assets' as const,fileType:'image' as const}];
  const before=await currentPromptReferences(f.db,projectId,scriptId,[],{info,trustedAssets:[]});
  assert.deepEqual(before.trustedAssets,[]);
  const binding={projectId,scriptId,targetKind:'asset' as const,targetId:assetId,expectedVersion:0,expectedSourceVersion:0,expectedSourceFileHash:hash(),idempotencyKey:'runtime-bind-one',items:[{remoteProjectName:'default',groupType:'AIGC' as const,groupId:'group-1',assetId:'asset-1',assetType:'Image' as const}]};
  await replaceVolcengineReferenceBindings(f.db,client,binding,'human:1',async()=>hash());
  const references=await loadOwnedVideoReferences(f.db,projectId,scriptId,info,toBase64,{transport:'url',useVolcengineTrustedAssets:true});
  assert.equal(references.length,1);assert.equal(references[0].url,'asset://asset-1');assert.equal(references[0].type,'image');
  assert.equal(references[0].leaseId,undefined,'a trusted asset must not create a NAS public lease');
  assert.equal(references[0].base64,undefined);assert.equal(references[0].trustedAsset?.sourceFileHash,hash());
  const after=await currentPromptReferences(f.db,projectId,scriptId,[],before);
  assert.notDeepEqual(after,before,'binding changes must invalidate the same saved prompt review');
  const ordinary=await currentPromptReferences(f.db,projectId,scriptId,[],{info});
  assert.equal(Object.hasOwn(ordinary,'trustedAssets'),false,'other providers retain their original reference identity');
  await revalidateTrustedVideoReferences(f.db,'volcengineSd2:model',{referenceList:references},toBase64);
  assert(actions.every(action=>['GetAsset','GetAssetGroup'].includes(action)));
  const count=actions.length;data='data:image/png;base64,Yg==';
  await assert.rejects(revalidateTrustedVideoReferences(f.db,'volcengineSd2:model',{referenceList:references},toBase64),(e:any)=>e.submissionOutcome==='not_submitted');
  assert.equal(actions.length,count,'changed source bytes are rejected before remote checks or a paid request');
  await revalidateTrustedVideoReferences(f.db,'agentsYun:model',{referenceList:references},toBase64);
  await replaceVolcengineReferenceBindings(f.db,undefined,{...binding,expectedVersion:1,expectedSourceFileHash:hash(),idempotencyKey:'runtime-unbind-one',items:[]},'human:1',async()=>hash());
  await assert.rejects(revalidateTrustedVideoReferences(f.db,'volcengineSd2:model',{referenceList:references},toBase64),(e:any)=>e.submissionOutcome==='not_submitted');
  await f.db('o_vendorConfig').where({id:'volcengineSd2'}).update({inputValues:'{}'});
  const local=await loadOwnedVideoReferences(f.db,projectId,scriptId,info,toBase64,{useVolcengineTrustedAssets:true});
  assert.equal(local[0].base64,data,'unbound references do not require AK/SK and continue through NAS');
 } finally {t.mock.restoreAll();await f.destroy();}
});
