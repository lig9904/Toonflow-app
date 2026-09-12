import type {Knex} from 'knex';
import {readRoleVoiceCasting} from './roleAudioWorkspace';
/** Explicit episode assets, plus the current voice of a character used by that episode. */
export async function canUseScriptAsset(db:Knex|Knex.Transaction,projectId:number,scriptId:number,assetId:number):Promise<boolean>{
 const [asset,script]=await Promise.all([db('o_assets').where({id:assetId,projectId}).first(),db('o_script').where({id:scriptId,projectId}).first('id')]);
 if(!asset||!script)return false;
 if(await db('o_scriptAssets').where({scriptId,assetId}).first())return true;
 if(asset.type!=='audio'||!await db.schema.hasTable('o_assetsRole2Audio'))return false;
 const roles=await db('o_assets as role').join('o_scriptAssets as link','link.assetId','role.id').where({'role.projectId':projectId,'role.type':'role','link.scriptId':scriptId}).select('role.id');
 const boardRoles=await db.schema.hasTable('o_assets2Storyboard')?await db('o_assets as role').join('o_assets2Storyboard as link','link.assetId','role.id').join('o_storyboard as board','board.id','link.storyboardId').where({'role.projectId':projectId,'role.type':'role','board.projectId':projectId,'board.scriptId':scriptId}).select('role.id'):[];
 const ids=[...new Set([...roles,...boardRoles].map(r=>Number(r.id)))];
 return (await readRoleVoiceCasting(db as Knex,projectId,ids)).some(v=>v.audioId===assetId);
}
