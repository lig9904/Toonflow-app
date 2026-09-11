import express from 'express';
import u from '@/utils';
import fg from 'fast-glob';
import {success} from '@/lib/responseFormat';
import {readModelPrompt} from '@/services/managedModelPrompts';
import {promptPaths,sendPromptError} from '../promptManage/_shared';
export default express.Router().get('/',async(_req,res)=>{try{
 const paths=promptPaths(),files=await fg(['image/*.md','video/*.md'],{cwd:paths.modelPromptDir,onlyFiles:true,followSymbolicLinks:false});
 const entries=await Promise.all(files.map(file=>readModelPrompt(u.db,paths,file)));return res.send(success(entries));
}catch(e){return sendPromptError(res,e);}});
