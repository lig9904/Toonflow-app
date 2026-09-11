import express from 'express';
import {z} from 'zod';
import u from '@/utils';
import {success} from '@/lib/responseFormat';
import {requestUserId,sendProjectContentError} from '@/services/projectContent/http';
import {requireProjectAccess} from '@/services/team';
import {getBuiltinAgentRuntime} from '@/services/builtinAgent/runtime';
import {readManagedPrompt} from '@/services/promptRegistry';
import {BuiltinRuntimeError} from '@/services/builtinAgentRuntime';
import {readAssetExtractionSnapshot,AssetExtractionWorkspaceError} from '@/services/assetExtractionWorkspace';
const inputSchema=z.object({projectId:z.coerce.number().int().positive(),scriptIds:z.array(z.coerce.number().int().positive()).min(1).max(100),versions:z.array(z.object({id:z.coerce.number().int().positive(),expectedVersion:z.number().int().nonnegative()})).min(1).max(100),idempotencyKey:z.string().min(8).max(110),groupSize:z.number().positive().optional()});
export default express.Router().post('/',async(req,res)=>{
 try{
  const input=inputSchema.parse(req.body),userId=requestUserId(req);
  await requireProjectAccess(u.db,userId,input.projectId,'edit');
  const ids=[...new Set(input.scriptIds)].sort((a,b)=>a-b),versions=[...input.versions].sort((a,b)=>a.id-b.id);
  if(ids.length!==input.scriptIds.length||versions.length!==ids.length||versions.some((s,i)=>s.id!==ids[i]))throw Object.assign(new Error('剧本范围与版本不一致，请刷新后重试'),{status:400});
  const runtime=getBuiltinAgentRuntime(),key=`manual-assets:${input.idempotencyKey}`;
  const old=await runtime.findByIdempotency(userId,key);
  if(old){const intent=old.intent as any;if(old.projectId!==input.projectId||intent?.phase!=='extractAssets'||JSON.stringify(intent.context?.sourceScripts)!==JSON.stringify(versions))throw Object.assign(new Error('该请求已绑定另一组剧本或版本'),{status:409});return res.send(success({runId:old.id,reused:true}));}
  await readAssetExtractionSnapshot(u.db,{projectId:input.projectId,sourceScripts:versions});
  const instructions=(await readManagedPrompt(u.db,'common.scriptAssetExtraction',{skillsDir:u.getPath('skills'),modelPromptDir:u.getPath('modelPrompt')})).content;
  const result=await runtime.create({agentType:'scriptAgent',projectId:input.projectId,scriptId:null,requestedBy:userId,idempotencyKey:key,prompt:'为本次选定剧本提取并复用角色、场景、道具，按真实ID关联所选剧本；保留不同形态与人工设定。',intent:{phase:'extractAssets',context:{projectId:input.projectId,sourceScripts:versions,instructions}},limits:{maxModelCalls:2,maxToolSteps:12,maxOutputTokens:64000,maxImageGenerations:0,maxVideoGenerations:0}});
  runtime.start();return res.status(202).send(success({runId:result.run.id,reused:result.reused}));
 }catch(e){if(e instanceof BuiltinRuntimeError||e instanceof AssetExtractionWorkspaceError)return res.status(['CONFLICT','STALE_VERSION','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT'].includes(e.code)?409:e.code==='FORBIDDEN'?403:400).send({code:e.code,message:e.message});return sendProjectContentError(res,e);}
});
