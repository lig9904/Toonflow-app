import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPostgresFixture,migratePostgresFixture} from '../src/lib/postgresTest';
import {writeModelPrompt,readModelPrompt,deleteModelPrompt} from '../src/services/managedModelPrompts';
import {readManagedPrompt} from '../src/services/promptRegistry';
const options={skip:!process.env.TOONFLOW_TEST_DATABASE_URL};
test('model template editor uses registry effective versions and blocks filesystem bypasses',options,async()=>{
 const f=await createPostgresFixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'model-mapping-'));
 try{await migratePostgresFixture(f.db);await fs.mkdir(path.join(root,'video'));await fs.writeFile(path.join(root,'video/textMode.md'),'default text mode');const paths={modelPromptDir:root,skillsDir:root},actor={id:'human:1',kind:'human'};
  const initial=await readModelPrompt(f.db,paths,'video/textMode.md');const changed=await writeModelPrompt(f.db,paths,{name:'textMode',type:'video',data:'custom text mode',expectedVersion:initial.version,idempotencyKey:'mapped-edit-1'},actor);assert.equal(changed.data,'custom text mode');assert.equal((await readManagedPrompt(f.db,'video.text',paths)).content,'custom text mode');assert.equal(await fs.readFile(path.join(root,'video/textMode.md'),'utf8'),'default text mode');
  await assert.rejects(writeModelPrompt(f.db,paths,{name:'textMode',type:'video',data:'bypass'},actor,true));await assert.rejects(deleteModelPrompt(f.db,paths,'video/textMode.md',changed.version,{actor:'human:1',idempotencyKey:'delete-builtin'}));await assert.rejects(writeModelPrompt(f.db,paths,{name:'../outside',type:'video',data:'escape'},actor,true));
  const custom=await writeModelPrompt(f.db,paths,{name:'custom',type:'video',data:'one',idempotencyKey:'create-custom'},actor,true);const newer=await writeModelPrompt(f.db,paths,{name:'custom',type:'video',data:'two',expectedVersion:custom.version,idempotencyKey:'update-custom'},actor);assert.notEqual(newer.version,custom.version);assert.deepEqual(await writeModelPrompt(f.db,paths,{name:'custom',type:'video',data:'one',idempotencyKey:'create-custom'},actor,true),custom);await assert.rejects(writeModelPrompt(f.db,paths,{name:'custom',type:'video',data:'DIFFERENT',idempotencyKey:'create-custom'},actor,true));await assert.rejects(writeModelPrompt(f.db,paths,{name:'custom',type:'video',data:'stale',expectedVersion:custom.version,idempotencyKey:'stale-custom'},actor));
  await f.db('o_modelPrompt').insert({vendorId:'fixture',model:'video',path:'video/custom.md'});await assert.rejects(deleteModelPrompt(f.db,paths,'video/custom.md',newer.version,{actor:'human:1',idempotencyKey:'delete-bound'}));await f.db('o_modelPrompt').del();const d=await deleteModelPrompt(f.db,paths,'video/custom.md',newer.version,{actor:'human:1',idempotencyKey:'delete-custom'});assert.deepEqual(await deleteModelPrompt(f.db,paths,'video/custom.md',newer.version,{actor:'human:1',idempotencyKey:'delete-custom'}),d);
 }finally{await f.destroy();await fs.rm(root,{recursive:true,force:true});}
});
