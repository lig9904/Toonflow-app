import type { Knex } from 'knex';
import type { BuiltinExecutionContext } from '../builtinAgentRuntime';
import type { BuiltinRunView } from './contracts';
import { BuiltinRuntimeError } from '../builtinAgentRuntime';
import { createAssetExtractionHelper } from './assetExtraction';
import { readAssetExtractionSnapshot } from '../assetExtractionWorkspace';
import type { StructuredScriptModel } from './scriptExecutor';
export interface ManualExtractionContext { projectId: number; sourceScripts: Array<{id: number; expectedVersion: number}>; instructions: string }
export async function ensureManualExtractionSchema(db: Knex) {
  if (!await db.schema.hasColumn('o_script', 'extractRunId')) await db.schema.alterTable('o_script', t=>t.uuid('extractRunId').nullable());
}
export async function initializeManualExtraction(trx: Knex.Transaction, run: BuiltinRunView) {
  const context = (run.intent as any)?.context as ManualExtractionContext;
  if (!context || context.projectId !== run.projectId || !context.sourceScripts?.length || !context.instructions?.trim()) throw new BuiltinRuntimeError('INVALID_INPUT','素材提取运行缺少有效范围和规范');
  await readAssetExtractionSnapshot(trx, {projectId: context.projectId, sourceScripts: context.sourceScripts});
  const ids=context.sourceScripts.map(s=>s.id);
  const busy=await trx('o_script as s').join('ext_builtin_runs as r','r.id','s.extractRunId').where('s.projectId',context.projectId).whereIn('s.id',ids).whereIn('r.status',['queued','running','paused','waiting_human']).first();
  if (busy) throw new BuiltinRuntimeError('CONFLICT','选定剧本已有素材提取任务，请先处理已有任务');
  await trx('o_script').where({projectId:context.projectId}).whereIn('id',ids).update({extractRunId:run.id,extractState:0,errorReason:null});
}
export function createManualAssetExtractionExecutor(deps:{db:Knex;model:StructuredScriptModel}) {
  return async (ctx:BuiltinExecutionContext)=>{
    const context=(ctx.run.intent as any)?.context as ManualExtractionContext;
    if (!context || context.projectId!==ctx.run.projectId) throw new BuiltinRuntimeError('INVALID_INPUT','素材提取范围无效');
    const ids=context.sourceScripts.map(s=>s.id);
    const extract=createAssetExtractionHelper({...deps,requireBindings:true,loadInstructions:async()=>context.instructions,onSaved:async trx=>{await trx("o_script").where({projectId:context.projectId,extractRunId:ctx.run.id}).whereIn("id",ids).update({extractState:1,errorReason:null});}});
    try {
      const result=await extract(ctx,{projectId:context.projectId,sourceScripts:context.sourceScripts,request:ctx.run.continuation||ctx.run.prompt,maxOutputTokens:ctx.run.limits.maxOutputTokens,useModelOutputLimit:true,stepKey:'manual.extractAssets'});
      await ctx.emit('message.completed',{text:`素材提取已保存，已关联 ${result.bindings.length} 集剧本。`});
      return result;
    } catch(error) {
      // The run owns this status pointer. Never rewrite the state of a newer request.
      const active=await deps.db('ext_builtin_runs').where({id:ctx.run.id}).first();
      const saved = await deps.db('ext_builtin_run_steps').where({runId:ctx.run.id,stepKey:`manual.extractAssets.save:r${ctx.run.inputRevision??0}`,status:'succeeded'}).first();
      if (!saved && active?.status!=='paused') await deps.db('o_script').where({projectId:context.projectId,extractRunId:ctx.run.id}).whereIn('id',ids).update({extractState:-1,errorReason:error instanceof Error?error.message.slice(0,1000):'素材提取失败'});
      throw error;
    }
  };
}
export async function reconcileManualExtractionStates(db:Knex,ids:number[]) {
  const rows=await db('o_script as s').join('ext_builtin_runs as r','r.id','s.extractRunId').whereIn('s.id',ids).where('s.extractState',0).whereIn('r.status',['failed','cancelled','reconciliation_required']).select('s.id','s.extractRunId','r.status','r.errorMessage');
  for (const row of rows) await db('o_script').where({id:row.id,extractRunId:row.extractRunId,extractState:0}).update({extractState:-1,errorReason:row.status==='cancelled'?'素材提取已取消':row.errorMessage||'素材提取未完成'});
}
