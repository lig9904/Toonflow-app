import express from 'express';
import { z } from 'zod';
import u from '@/utils';
import { success } from '@/lib/responseFormat';
import { requireProductionOwner, sendProductionError } from '@/services/productionHttp';
import { getConfiguredMediaModel } from '@/utils/ai';
import { resolveStoredVideoMode, captureVideoModeSelectionSnapshot } from '@/services/videoModeResolution';
import { preflightVideoPrompt } from '@/services/videoPromptReview';
import { videoPreflightVerdict } from '@/lib/videoPreflightContract';
const ref=z.object({id:z.number().int().positive(),sources:z.enum(['assets','storyboard']),fileType:z.enum(['image','video','audio']).optional(),purpose:z.enum(['first_frame','last_frame','identity_reference','style_reference','motion_reference','audio_reference']).optional()}).strict();
const schema=z.object({projectId:z.number().int().positive(),scriptId:z.number().int().positive(),model:z.string().min(1),resolution:z.string(),audio:z.boolean().optional(),trackData:z.array(z.object({trackId:z.number().int().positive(),prompt:z.string(),duration:z.number().finite(),references:z.array(ref).max(100),modeIntentRevision:z.number().int().nonnegative(),acknowledgement:z.string().optional()}).strict()).min(1).max(20)}).strict();
export default express.Router().post('/',async(req,res)=>{try{
 const input=schema.parse(req.body);await requireProductionOwner(req,input.projectId,u.db);
 const reports=[];
 for(const item of input.trackData){
  if(!await u.db('o_videoTrack').where({id:item.trackId,projectId:input.projectId,scriptId:input.scriptId}).first())return res.status(404).send({code:'NOT_FOUND',message:'片段不属于当前项目或剧集'});
  const shot=await u.db('o_storyboard').where({trackId:item.trackId,projectId:input.projectId,scriptId:input.scriptId}).orderBy('index').first('index');
  const shotLabel=shot?`S${String(Number(shot.index)+1).padStart(2,'0')}`:`自建片段 T${item.trackId}`;
  try{
   const capabilities=await getConfiguredMediaModel(input.model,'video');
   const mode=await resolveStoredVideoMode(u.db,{projectId:input.projectId,scriptId:input.scriptId,trackId:item.trackId,model:input.model,capabilities,references:item.references,expectedIntentRevision:item.modeIntentRevision});
   const binding=await captureVideoModeSelectionSnapshot(u.db,{projectId:input.projectId,scriptId:input.scriptId,trackId:item.trackId,resolution:mode},path=>u.oss.getImageBase64(path));
   reports.push(await preflightVideoPrompt(u.db,{projectId:input.projectId,scriptId:input.scriptId,trackId:item.trackId,prompt:item.prompt,model:input.model,mode:mode.resolvedMode,generation:{duration:item.duration,resolution:input.resolution,audio:input.audio??false},info:mode.resolvedReferences,capabilities,collectOnly:true,acknowledgement:item.acknowledgement,referenceBinding:binding}));
  }catch(error){const issue={code:String((error as any)?.code??'INPUT_UNAVAILABLE'),severity:'error' as const,message:error instanceof Error?error.message:'输入检查失败，请重新读取当前片段',overridable:false};reports.push({status:'issues',findings:[issue],summary:'视频尚未提交',revised:false,reviewedAt:Date.now(),preflight:videoPreflightVerdict({trackId:item.trackId,shotLabel,binding:item,issues:[issue]})});}
 }
 res.send(success({reports,submissionOutcome:'not_submitted'}));
}catch(error){sendProductionError(res,error);}});
