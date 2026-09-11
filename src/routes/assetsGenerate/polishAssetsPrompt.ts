import express from 'express';
import u from '@/utils';
import {success} from '@/lib/responseFormat';
import {startManualPolish} from '@/services/manualPolishRequest';
import {sendProjectContentError} from '@/services/projectContent/http';
import {BuiltinRuntimeError} from '@/services/builtinAgentRuntime';
import {getBuiltinAgentRuntime} from '@/services/builtinAgent/runtime';
export default express.Router().post('/',async(req,res)=>{try{
 const receipt=await startManualPolish(req,false),runtime=getBuiltinAgentRuntime();
 // Single-item callers historically wait for the text. Keep that response while the run is durable.
 const end=Date.now()+240000;let run=await runtime.get(receipt.runId);
 while(['queued','running'].includes(run.status)&&Date.now()<end){await new Promise(r=>setTimeout(r,400));run=await runtime.get(receipt.runId);}
 const result=(run.result as any)?.results?.find((r:any)=>r.assetId===Number(req.body.assetsId));
 if(result&&!result.error)return res.send(success({assetsId:result.assetId,prompt:result.prompt,version:result.version,...receipt}));
 if(['queued','running','paused'].includes(run.status))return res.status(202).send(success({...receipt,pending:true,assetsId:Number(req.body.assetsId)}));
 throw new BuiltinRuntimeError('INVALID_INPUT',result?.error||run.errorMessage||'提示词生成未完成');
}catch(e){if(e instanceof BuiltinRuntimeError)return res.status(409).send({code:e.code,message:e.message});return sendProjectContentError(res,e);}});
