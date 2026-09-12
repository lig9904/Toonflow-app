import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyImageFinding,videoPreflightVerdict,videoSettingsIssues} from '../src/lib/videoPreflightContract';
import {buildStoryboardImagePrompt,buildStoryboardVideoPrompt} from '../src/lib/storyboardVisualContract';
test('S10 still image uses only opening close-up; later full-body cut remains in video',()=>{
 const prompt='100mm潮纹大特写。湿沙上蓝色同心潮纹稳定，随后一条黑色裂痕向中央蔓延。';
 const videoDesc='先稳定半秒，随即切35mm侧面全景：九九全身被冲击掀起。';
 const image=buildStoryboardImagePrompt({prompt,videoDesc,assets:[{id:19,name:'九九',type:'role'}]});
 assert.match(image,/100mm潮纹大特写/);assert.doesNotMatch(image,/35mm|全身被冲击|黑色裂痕向中央蔓延/);
 assert.match(buildStoryboardVideoPrompt([{prompt,videoDesc,duration:4}]),/35mm侧面全景/);
});
test('framing is irrelevant for identity/style reference but remains a confirmable issue on a first frame',()=>{
 const finding={code:'SHOT_FRAMING_MISMATCH',severity:'error' as const,message:'full body instead of close-up'};
 assert.equal(classifyImageFinding(finding,'identity_reference').severity,'info');
 assert.equal(classifyImageFinding(finding,'style_reference').severity,'info');
 assert.equal(classifyImageFinding(finding,'first_frame').severity,'error');
 assert.equal(classifyImageFinding(finding,'first_frame').overridable,true);
});
test('acknowledgement is bound to exact references, prompt, params and review result',()=>{
 const issues=[{code:'SHOT_FRAMING_MISMATCH',severity:'error' as const,message:'mismatch',overridable:true}];
 const base={trackId:89,shotLabel:'S10',binding:{hash:'A',prompt:'P',resolution:'480p',version:1},issues};
 const first=videoPreflightVerdict(base);assert.equal(first.canSubmit,false);
 assert.equal(videoPreflightVerdict({...base,acknowledgement:first.fingerprint}).canSubmit,true);
 for(const binding of [{...base.binding,hash:'B'},{...base.binding,prompt:'new'},{...base.binding,resolution:'720p'},{...base.binding,version:2}]) assert.equal(videoPreflightVerdict({...base,binding,acknowledgement:first.fingerprint}).canSubmit,false);
 assert.equal(videoPreflightVerdict({...base,issues:[{...issues[0],message:'new review'}],acknowledgement:first.fingerprint}).canSubmit,false);
});
test('mandatory integrity errors cannot be bypassed even with a matching fingerprint',()=>{
 const base={trackId:89,shotLabel:'S10',binding:'a',issues:[{code:'REFERENCE_MISSING',severity:'error' as const,message:'missing',overridable:false}]};
 const first=videoPreflightVerdict(base);assert.equal(videoPreflightVerdict({...base,acknowledgement:first.fingerprint}).canSubmit,false);
});

test('model parameter failures remain mandatory and tail frames do not inherit first-frame framing rejection',()=>{
 assert.equal(videoSettingsIssues({audio:false,durationResolutionMap:[{duration:[4,5],resolution:['480p']}]},{duration:30,resolution:'1080p',audio:true}).filter(i=>i.severity==='error'&&!i.overridable).length,2);
 assert.equal(classifyImageFinding({code:'SHOT_FRAMING_MISMATCH',severity:'error',message:'opening close-up mismatch'},'last_frame').severity,'warning');
});

test('model finding code casing cannot turn framing into an unacknowledgeable error',()=>{
 const f={code:'shot_size_mismatch',severity:'error' as const,message:'近景生成了全身'};
 assert.equal(classifyImageFinding(f,'first_frame').overridable,true);
 assert.equal(classifyImageFinding(f,'identity_reference').severity,'info');
 assert.equal(classifyImageFinding({...f,code:'identity_mismatch'},'first_frame').overridable,false);
});
