import express from 'express';
import u from '@/utils';
import {success} from '@/lib/responseFormat';
import {PromptRegistryError} from '@/services/promptRegistry';
import {writeModelPrompt} from '@/services/managedModelPrompts';
import {promptPaths,promptActor,sendPromptError} from '../promptManage/_shared';
export default express.Router().post('/',async(req,res)=>{try{
 if(!['image','video'].includes(req.body?.type))throw new PromptRegistryError('INVALID_INPUT','模板类型无效');
 return res.send(success(await writeModelPrompt(u.db,promptPaths(),req.body,promptActor(req))));
}catch(e){return sendPromptError(res,e);}});
