import type {Request} from 'express';
import {z} from 'zod';
import u from '../utils';
import {requestUserId} from './projectContent/http';
import {requireProjectAccess} from './team';
import {getBuiltinAgentRuntime} from './builtinAgent/runtime';
import {getCreativeState} from './creativeWorkspace';
import {BuiltinRuntimeError} from './builtinAgentRuntime';
const item=z.object({assetsId:z.coerce.number().int().positive(),expectedVersion:z.number().int().nonnegative(),name:z.string().optional(),describe:z.string().optional(),type:z.string().optional()});
export async function startManualPolish(req:Request,batch:boolean){
 const raw=batch?req.body:{...req.body,items:[req.body]};
 const input=z.object({projectId:z.coerce.number().int().positive(),items:z.array(item).min(1).max(50),otherTextPrompt:z.string().max(10000).default(''),idempotencyKey:z.string().min(8).max(100)}).parse(raw);
 const actor=requestUserId(req);await requireProjectAccess(u.db,actor,input.projectId,'edit');
 if(new Set(input.items.map(i=>i.assetsId)).size!==input.items.length)throw new BuiltinRuntimeError('INVALID_INPUT','素材重复');
 const runtime=getBuiltinAgentRuntime(),key=`manual-polish:${input.idempotencyKey}`;
 const old=await runtime.findByIdempotency(actor,key);
 if(old){const c=(old.intent as any)?.context;if(old.projectId!==input.projectId||c?.otherTextPrompt!==input.otherTextPrompt||JSON.stringify(c.items.map((i:any)=>({assetsId:i.assetsId,expectedVersion:i.expectedVersion})))!==JSON.stringify(input.items.map(i=>({assetsId:i.assetsId,expectedVersion:i.expectedVersion}))))throw new BuiltinRuntimeError('CONFLICT','同一请求已绑定不同素材');return {runId:old.id,reused:true,total:input.items.length};}
 const project=await u.db('o_project').where({id:input.projectId}).first(),manuals=new Map<string,string>();
 const items=[];
 for(const it of input.items){
  const asset=await u.db('o_assets').where({id:it.assetsId,projectId:input.projectId}).first();
  if(!asset||!['role','scene','tool'].includes(String(asset.type))||(await getCreativeState(u.db,'asset',it.assetsId,input.projectId)).version!==it.expectedVersion)throw new BuiltinRuntimeError('CONFLICT','素材或版本已变化，请刷新');
  const file=`art_${({role:'character',scene:'scene',tool:'prop'} as Record<string,string>)[String(asset.type)]}${asset.assetsId?'_derivative':''}`;
  if(!manuals.has(file))manuals.set(file,u.getArtPrompt(project?.artStyle??'','art_skills',file));
  items.push({assetsId:it.assetsId,expectedVersion:it.expectedVersion,name:String(asset.name??''),describe:String(asset.describe??''),type:String(asset.type),system:manuals.get(file)!});
 }
 const result=await runtime.create({agentType:'productionAgent',projectId:input.projectId,scriptId:null,requestedBy:actor,idempotencyKey:key,prompt:input.otherTextPrompt||'根据当前素材身份和项目风格生成素材提示词',intent:{phase:'polishAssets',context:{projectId:input.projectId,items,otherTextPrompt:input.otherTextPrompt}},limits:{maxModelCalls:input.items.length,maxToolSteps:Math.min(200,input.items.length*2+3),maxOutputTokens:64000,maxImageGenerations:0,maxVideoGenerations:0}});runtime.start();return {runId:result.run.id,reused:result.reused,total:items.length};
}
