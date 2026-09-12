import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {getArtPrompt} from '../src/utils/getArtPrompt';
import {assetPromptSystem,creativeIdentityRules} from '../src/lib/creativePromptPolicy';
import {promptDefinitions} from '../src/services/promptRegistry';
const root=path.resolve('data/skills');
const walk=(dir:string):string[]=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
test('all shipped skill documents are readable and all managed skills resolve uniquely',()=>{
 const files=walk(root).filter(f=>f.endsWith('.md'));assert.ok(files.length>100);
 for(const file of files){const body=fs.readFileSync(file,'utf8');assert.ok(body.trim(),file);assert.ok(!body.includes('\u0000'),file);}
 const managed=promptDefinitions.filter(d=>d.group==='skill');assert.equal(new Set(managed.map(d=>d.file)).size,managed.length);
 for(const d of managed)assert.ok(fs.readFileSync(path.join(root,d.file!),'utf8').trim(),d.key);
});
test('every selectable visual style resolves every active asset and storyboard manual under identity precedence',()=>{
 const styles=fs.readdirSync(path.join(root,'art_skills'));
 for(const style of styles)for(const purpose of ['art_character','art_scene','art_prop','art_character_derivative','art_scene_derivative','art_prop_derivative','art_storyboard_video']){
  const manual=getArtPrompt(style,'art_skills',purpose);assert.ok(manual.startsWith(creativeIdentityRules),style+':'+purpose);assert.match(manual,/以上仅为表现参考/);
  const single=assetPromptSystem(manual,true);assert.match(single,/本次版式已明确为单幅/);const body=single.split('<visual_reference>')[1].split('</visual_reference>')[0];assert.doesNotMatch(body,/四视图|多视图|三视图|多宫格|拼版/);
 }
});
test('every selectable narrative style resolves both director stages with user duration and identity precedence',()=>{
 for(const style of fs.readdirSync(path.join(root,'story_skills')))for(const purpose of ['director_planning_narrative','director_storyboard_table_narrative']){
  const manual=getArtPrompt(style,'story_skills',purpose);assert.ok(manual.startsWith(creativeIdentityRules),style+':'+purpose);assert.match(manual,/用户镜数时长/);
 }
});
