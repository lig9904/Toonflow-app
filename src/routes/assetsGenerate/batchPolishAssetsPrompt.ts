import express from 'express';
import {success} from '@/lib/responseFormat';
import {startManualPolish} from '@/services/manualPolishRequest';
import {sendProjectContentError} from '@/services/projectContent/http';
import {BuiltinRuntimeError} from '@/services/builtinAgentRuntime';
export default express.Router().post('/',async(req,res)=>{try{return res.status(202).send(success(await startManualPolish(req,true)));}catch(e){if(e instanceof BuiltinRuntimeError)return res.status(409).send({code:e.code,message:e.message});return sendProjectContentError(res,e);}});
