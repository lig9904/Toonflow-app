import express from 'express';
import {z} from 'zod';
import u from '@/utils';
import {success} from '@/lib/responseFormat';
import {uploadAsset} from '@/services/assetWorkspace';
import {actor,send,storage,userId} from '@/services/assetWorkspace/http';
import {requireProjectAccess} from '@/services/team';
const schema=z.object({projectId:z.number().int().positive(),type:z.enum(['role','tool','scene']),name:z.string().trim().min(1,'请输入资产名称'),describe:z.string().optional(),base64:z.string().regex(/^data:image\/(png|jpeg|webp);base64,/, '请选择 PNG、JPEG 或 WebP 图片'),idempotencyKey:z.string().min(1)}).strict();
export default express.Router().post('/',async(req,res)=>{try{
 const result=schema.safeParse(req.body);if(!result.success)return res.status(400).send({code:'INVALID_INPUT',message:result.error.issues[0]?.message??'上传参数无效'});
 await requireProjectAccess(u.db,userId(req),result.data.projectId,'edit');
 return res.send(success(await uploadAsset(u.db,result.data,actor(req),storage(u.oss))));
}catch(error){return send(res,error);}});
