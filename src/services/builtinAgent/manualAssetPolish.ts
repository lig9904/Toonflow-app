import type {Knex} from 'knex';
import {z} from 'zod';
import pLimit from 'p-limit';
import type {BuiltinExecutionContext} from '../builtinAgentRuntime';
import {BuiltinRuntimeError} from '../builtinAgentRuntime';
import type {BuiltinRunView} from './contracts';
import {builtinThinkLevelFromIntent} from './contracts';
import type {StructuredScriptModel} from './scriptExecutor';
import {getCreativeState} from '../creativeWorkspace';
import {updateAsset} from '../assetWorkspace';
import {assetPromptSystem} from '../../lib/creativePromptPolicy';
export interface PolishItem {assetsId:number;expectedVersion:number;name:string;describe:string;type:string;system:string}
export interface PolishContext {projectId:number;items:PolishItem[];otherTextPrompt:string;concurrentCount?:number}
export async function ensureManualPolishSchema(db:Knex){if(!await db.schema.hasColumn('o_assets','promptRunId'))await db.schema.alterTable('o_assets',t=>t.uuid('promptRunId').nullable());}
export async function initializeManualPolish(trx:Knex.Transaction,run:BuiltinRunView){
 const c=(run.intent as any)?.context as PolishContext;
 if(!c||c.projectId!==run.projectId||!c.items.length)throw new BuiltinRuntimeError('INVALID_INPUT','素材润色范围无效');
 for(const item of c.items){
  const row=await trx('o_assets').where({id:item.assetsId,projectId:c.projectId}).first();
  if(!row||row.type!==item.type||(await getCreativeState(trx,'asset',item.assetsId,c.projectId)).version!==item.expectedVersion)throw new BuiltinRuntimeError('CONFLICT','素材或版本已变更，请刷新后重新润色');
  if(row.promptRunId){const active=await trx('ext_builtin_runs').where({id:row.promptRunId}).whereIn('status',['queued','running','paused']).first();if(active)throw new BuiltinRuntimeError('CONFLICT','选定素材已有提示词生成任务');}
 }
 await trx('o_assets').where({projectId:c.projectId}).whereIn('id',c.items.map(i=>i.assetsId)).update({promptRunId:run.id,promptState:'生成中',promptErrorReason:null});
}
export function createManualPolishExecutor(deps:{db:Knex;model:StructuredScriptModel}){
 return async(ctx:BuiltinExecutionContext)=>{
  const c=(ctx.run.intent as any)?.context as PolishContext;
  if(!c||c.projectId!==ctx.run.projectId)throw new BuiltinRuntimeError('INVALID_INPUT','素材润色上下文无效');
  const items=await ctx.step('polish.snapshot',{},async()=>c.items),results:any[]=[];
  const schema=z.object({prompt:z.string().min(1).max(50000)}).strict();
  const limit=pLimit(Math.max(1,Math.min(20,c.concurrentCount??1)));
  await Promise.all(items.map(item=>limit(async()=>{
   await ctx.assertActive();
   try{
    const generated=await ctx.step(`polish.model:${item.assetsId}`,{item,otherTextPrompt:c.otherTextPrompt},async()=>{
     if((await getCreativeState(deps.db,'asset',item.assetsId,c.projectId)).version!==item.expectedVersion)throw new BuiltinRuntimeError('CONFLICT','素材已经修改，本次旧润色未执行');
     const response=await deps.model.generate({role:'universalAi',system:assetPromptSystem(item.system),input:{asset:{id:item.assetsId,name:item.name,describe:item.describe,type:item.type},request:c.otherTextPrompt},schema,maxOutputTokens:0,useModelOutputLimit:true,signal:ctx.signal,thinkLevel:builtinThinkLevelFromIntent(ctx.run.intent)});
     return {value:schema.parse(response.value),outputTokens:response.outputTokens};
    },{modelCall:true});
    const saved=await ctx.commit(`polish.save:${item.assetsId}`,{item,prompt:generated.value.prompt},async trx=>{
     const row=await trx('o_assets').where({id:item.assetsId,projectId:c.projectId,promptRunId:ctx.run.id}).first();if(!row)throw new BuiltinRuntimeError('CONFLICT','素材提示词任务已更换');
     const result=await updateAsset(trx,{id:item.assetsId,projectId:c.projectId,expectedVersion:item.expectedVersion,idempotencyKey:`polish:${ctx.run.id}:${item.assetsId}`,name:item.name,describe:item.describe,prompt:generated.value.prompt},{kind:'agent',id:`agent:${ctx.run.id}`});
     await trx('o_assets').where({id:item.assetsId,promptRunId:ctx.run.id}).update({promptState:'已完成',promptErrorReason:null});return {assetId:item.assetsId,prompt:result.asset.prompt,version:result.asset.version};
    });results.push(saved);await ctx.emit('artifact.saved',{kind:'assetPrompt',ids:[item.assetsId],...saved});
   }catch(error){await ctx.assertActive();await deps.db('o_assets').where({id:item.assetsId,projectId:c.projectId,promptRunId:ctx.run.id}).update({promptState:'生成失败',promptErrorReason:error instanceof Error?error.message:'提示词生成失败'});results.push({assetId:item.assetsId,error:error instanceof Error?error.message:'提示词生成失败'});}
  })));
  return {outcome:results.some(r=>r.error)?'partial':'complete',results};
 };
}
export async function reconcileManualPolishStates(db:Knex,ids:number[]){
 const rows=await db('o_assets as a').join('ext_builtin_runs as r','r.id','a.promptRunId').whereIn('a.id',ids).where('a.promptState','生成中').whereIn('r.status',['failed','cancelled','reconciliation_required']).select('a.id','a.promptRunId','r.status','r.errorMessage');
 for(const row of rows)await db('o_assets').where({id:row.id,promptRunId:row.promptRunId,promptState:'生成中'}).update({promptState:'生成失败',promptErrorReason:row.status==='cancelled'?'提示词生成已取消':row.errorMessage||'提示词生成未完成'});
}
