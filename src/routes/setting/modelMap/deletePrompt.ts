import express from 'express';
import u from '@/utils';
import {success} from '@/lib/responseFormat';
import {deleteModelPrompt} from '@/services/managedModelPrompts';
import {promptPaths,promptActor,sendPromptError} from '../promptManage/_shared';
export default express.Router().post('/',async(req,res)=>{try{
 await deleteModelPrompt(u.db,promptPaths(),req.body?.path,req.body?.expectedVersion,{actor:promptActor(req).id,idempotencyKey:req.body?.idempotencyKey});return res.send(success(null));
}catch(e){return sendPromptError(res,e);}});
