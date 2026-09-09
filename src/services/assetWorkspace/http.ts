import type { Request,Response } from "express";
import type { AssetStorage } from "./index";
import { AssetWorkspaceError } from "./index";
export const userId=(req:Request)=>{const n=Number((req as any).teamPrincipal?.id??(req as any).user?.id);if(!Number.isSafeInteger(n)||n<=0)throw Object.assign(new Error("请先登录"),{status:401});return n};
export const actor=(req:Request)=>({id:"human:"+userId(req),kind:"human" as const});
export function storage(oss:any):AssetStorage{return{write:(p,d)=>oss.writeFile(p,d),delete:(p)=>oss.deleteFile(p),url:(p,image)=>image?oss.getSmallImageUrl(p):oss.getFileUrl(p)}}
export function send(res:Response,e:unknown){if(e instanceof AssetWorkspaceError){const s={INVALID_INPUT:400,NOT_FOUND:404,PROJECT_MISMATCH:403,VERSION_CONFLICT:409,IDEMPOTENCY_CONFLICT:409,REFERENCED:409,LOCKED:423}[e.code];return res.status(s).send({code:e.code,message:e.message})}const x=e as any;return res.status([400,401,403,404,409,423].includes(Number(x?.status))?Number(x.status):500).send({code:x?.code??"ASSET_FAILED",message:x?.message??"资产操作失败"})}
