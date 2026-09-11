import express from 'express';
import path from 'node:path';
import {z} from 'zod';
import u from '@/utils';
import {success} from '@/lib/responseFormat';
import {modelPromptTarget} from '@/services/managedModelPrompts';
import {PromptRegistryError} from '@/services/promptRegistry';
import {promptPaths,sendPromptError} from '../promptManage/_shared';
const schema=z.object({vendorId:z.string().min(1),model:z.string().min(1),path:z.string(),expectedPath:z.string(),fileName:z.string().optional()});
export default express.Router().post('/',async(req,res)=>{try{
 const input=schema.parse(req.body),file=input.path?await modelPromptTarget(promptPaths(),input.path):null;
 await u.db.transaction(async trx=>{
  await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',[`model-binding:${input.vendorId}:${input.model}`]);
  if(file){await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',[`model-prompt:${file.target}`]);await modelPromptTarget(promptPaths(),file.relative);}
  const row=await trx('o_modelPrompt').where({vendorId:input.vendorId,model:input.model}).first();
  if(String(row?.path??'')!==input.expectedPath)throw new PromptRegistryError('VERSION_CONFLICT','模型映射已被修改，请刷新后再绑定');
  const data={vendorId:input.vendorId,model:input.model,path:file?.relative??'',fileName:file?path.basename(file.relative,'.md'):''};
  if(row)await trx('o_modelPrompt').where({id:row.id}).update(data);else await trx('o_modelPrompt').insert(data);
 });return res.send(success(null));
}catch(e){if(e instanceof z.ZodError)return res.status(400).send({code:'INVALID_INPUT',message:'绑定参数或当前版本缺失'});return sendPromptError(res,e);}});
