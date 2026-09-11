import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Knex} from 'knex';
import {promptDefinitions,readManagedPrompt,saveManagedPrompt,type PromptPaths,PromptRegistryError} from './promptRegistry';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const invalid=(message:string)=>new PromptRegistryError('INVALID_INPUT',message);
const receiptsReady=new WeakMap<object,Promise<void>>();
async function fileMutation<T>(db:Knex,actor:string,key:string|undefined,input:unknown,perform:(trx:Knex.Transaction)=>Promise<T>):Promise<T>{
 if(!key||!/^[-\w:.]{8,150}$/.test(key))throw invalid("保存需要有效请求编号");
 if(!receiptsReady.has(db))receiptsReady.set(db,db.raw('CREATE TABLE IF NOT EXISTS ext_model_prompt_requests (actor text NOT NULL, key text NOT NULL, hash text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(actor,key))').then(()=>undefined));
 await receiptsReady.get(db);
 const hash=digest(JSON.stringify(input));
 return db.transaction(async trx=>{
  await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',[`model-request:${actor}:${key}`]);
  const previous=await trx('ext_model_prompt_requests').where({actor,key}).first();
  if(previous){if(previous.hash!==hash)throw new PromptRegistryError('IDEMPOTENCY_CONFLICT','请求编号已用于不同的模板操作');return typeof previous.result==='string'?JSON.parse(previous.result):previous.result;}
  const result=await perform(trx);await trx('ext_model_prompt_requests').insert({actor,key,hash,result:JSON.stringify(result)});return result;
 });
}
export async function modelPromptTarget(paths:PromptPaths,relative:string,missing=false){
 if(typeof relative!=='string'||!relative||relative.includes('\\')||path.isAbsolute(relative))throw invalid('模板路径无效');
 const root=await fs.realpath(paths.modelPromptDir),candidate=path.resolve(root,relative);
 if(!candidate.startsWith(root+path.sep))throw invalid('模板超出目录');
 let target:string;
 try{target=await fs.realpath(candidate);}catch(e:any){if(!missing||e.code!=='ENOENT')throw new PromptRegistryError('NOT_FOUND','模板不存在');const parent=await fs.realpath(path.dirname(candidate));target=path.join(parent,path.basename(candidate));}
 if(!target.startsWith(root+path.sep))throw invalid('模板超出目录');
 const canonical=path.relative(root,target).split(path.sep).join('/');
 if(!/^(image|video)\/[^/]+\.md$/.test(canonical))throw invalid('模板路径或类型无效');
 const definition=promptDefinitions.find(d=>d.group==='video'&&d.file===canonical);
 return {target,relative:canonical,definition};
}
export async function readModelPrompt(db:Knex,paths:PromptPaths,relative:string){
 const file=await modelPromptTarget(paths,relative);
 const managed=file.definition?await readManagedPrompt(db,file.definition.key,paths):undefined;
 const data=managed?.content??await fs.readFile(file.target,'utf8');
 return {path:file.relative,name:path.basename(file.relative,'.md'),type:file.relative.split('/')[0],data,version:managed?.version??digest(data),...(managed?{managedKey:managed.key}:{})};
}
export async function writeModelPrompt(db:Knex,paths:PromptPaths,input:{name:string;type:'image'|'video';data:string;expectedVersion?:string;idempotencyKey?:string},actor:{id:string;kind?:string},create=false){
 if(!input.name?.trim()||/[\\/\0]/.test(input.name)||input.name==='.'||input.name==='..'||!input.data?.trim()||input.data.length>100000)throw invalid('模板名称和非空正文必填，正文不超过100000字符');
 await fs.mkdir(path.join(paths.modelPromptDir,input.type),{recursive:true});
 const relative=`${input.type}/${input.name}.md`,file=await modelPromptTarget(paths,relative,create);
 if(file.definition){
  if(create)throw new PromptRegistryError('VERSION_CONFLICT','内置模板已存在，请编辑现有版本');
  const entry=await saveManagedPrompt(db,file.definition.key,{content:input.data,expectedVersion:input.expectedVersion!,idempotencyKey:input.idempotencyKey!,actor},paths);
  return {...await readModelPrompt(db,paths,file.relative),version:entry.version};
 }
 return fileMutation(db,actor.id,input.idempotencyKey,{operation:create?'create':'update',name:input.name,type:input.type,data:input.data,expectedVersion:input.expectedVersion},async trx=>{
  await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',[`model-prompt:${file.target}`]);
  if(create){try{await fs.writeFile(file.target,input.data,{encoding:'utf8',flag:'wx'});}catch(e:any){if(e.code==='EEXIST')throw new PromptRegistryError('VERSION_CONFLICT','同名模板已存在，不可覆盖');throw e;}}
  else {
   const current=await fs.readFile(file.target,'utf8');
   if(current!==input.data){
    if(digest(current)!==input.expectedVersion)throw new PromptRegistryError('VERSION_CONFLICT','模板已更新，请读取新版本后再保存');
    const temporary=file.target+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,input.data,{encoding:'utf8',flag:'wx'});await fs.rename(temporary,file.target);}finally{await fs.rm(temporary,{force:true});}
   }
  }
  return readModelPrompt(db,paths,file.relative);
 });
}
export async function deleteModelPrompt(db:Knex,paths:PromptPaths,relative:string,expectedVersion:string,options?:{actor:string;idempotencyKey:string}){
 return fileMutation(db,options?.actor??'internal',options?.idempotencyKey,{operation:'delete',relative,expectedVersion},async trx=>{
  const file=await modelPromptTarget(paths,relative);
  if(file.definition)throw invalid('内置模板不能删除，可在提示词管理中恢复默认');
  await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',[`model-prompt:${file.target}`]);
  if(await trx('o_modelPrompt').where({path:file.relative}).first())throw new PromptRegistryError('VERSION_CONFLICT','请先解除此模板的模型绑定');
  if(digest(await fs.readFile(file.target,'utf8'))!==expectedVersion)throw new PromptRegistryError('VERSION_CONFLICT','模板已更新，请刷新');
  await fs.unlink(file.target);return {deleted:true};
 });
}
