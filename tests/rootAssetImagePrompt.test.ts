import test from 'node:test';import assert from 'node:assert/strict';import {rootAssetImagePrompt} from '../src/services/rootAssetImages';
test('root image request respects single or explicit multi-view layout instead of forcing four views',()=>{
 const single=rootAssetImagePrompt('role','单幅画面，只有一只神兽，自然坐姿。');assert.doesNotMatch(single,/四视图/);assert.match(single,/只有一只神兽/);
 const sheet=rootAssetImagePrompt('role','绘制角色四视图，四个角度保持一致。');assert.match(sheet,/绘制角色四视图/);assert.equal((sheet.match(/四视图/g)||[]).length,1);
 assert.throws(()=>rootAssetImagePrompt('role','  '),/不能为空/);
});
