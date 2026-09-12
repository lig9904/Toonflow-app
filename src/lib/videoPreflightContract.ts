import { createHash } from 'node:crypto';
export interface VideoPreflightTarget { kind: 'storyboard' | 'asset'; id: number; referenceIndex: number; referenceLabel: string; purpose?: string; shotLabel?: string; artifactPath?: string | null; artifactHash?: string | null; reviewId?: string }
export interface VideoPreflightIssue { code: string; severity: 'error' | 'warning' | 'info'; message: string; target?: VideoPreflightTarget; overridable?: boolean; expected?: string; suggestion?: string }
export interface VideoPreflightVerdict { fingerprint: string; trackId: number; shotLabel: string; canSubmit: boolean; acknowledged: boolean; issues: VideoPreflightIssue[] }
export const SUBJECTIVE_IMAGE_CODES = new Set(['SHOT_FRAMING_MISMATCH','ENVIRONMENT_STYLE_DEVIATION','COMPOSITION_MISMATCH','SHOT_SIZE_MISMATCH']);
export function classifyImageFinding(finding: {code:string;severity:'error'|'warning'|'info';message:string}, purpose?: string) {
  const canonicalCode=finding.code.toUpperCase();
  const framing=/FRAMING|SHOT_SIZE|COMPOSITION/.test(canonicalCode);
  // A character/style reference defines identity or appearance, not the output camera framing.
  const contextualReference=purpose==='identity_reference'||purpose==='style_reference';
  return {...finding,message:framing&&contextualReference?`${finding.message} 此图仅用于身份或风格参考，该取景发现不限制输出镜头。`:framing&&purpose==='last_frame'?`${finding.message} 此图当前用作尾帧，应按结束状态核对，不能直接套用首帧构图结论。`:finding.message,severity:framing&&purpose==='last_frame'?'warning' as const:framing&&contextualReference?'info' as const:finding.severity,overridable:SUBJECTIVE_IMAGE_CODES.has(canonicalCode)};
}
const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)])):v;
export function videoPreflightVerdict(input: {trackId:number;shotLabel:string;binding:unknown;issues:VideoPreflightIssue[];acknowledgement?:string}): VideoPreflightVerdict {
  const fingerprint=createHash('sha256').update(JSON.stringify(stable({trackId:input.trackId,shotLabel:input.shotLabel,binding:input.binding,issues:input.issues}))).digest('hex');
  const errors=input.issues.filter(i=>i.severity==='error');
  const acknowledged=!!errors.length&&input.acknowledgement===fingerprint&&errors.every(i=>i.overridable===true);
  return {fingerprint,trackId:input.trackId,shotLabel:input.shotLabel,canSubmit:!errors.length||acknowledged,acknowledged,issues:input.issues};
}

export function videoSettingsIssues(capabilities:any,generation:{duration?:number;resolution?:string;audio?:boolean}):VideoPreflightIssue[]{
 const issues:VideoPreflightIssue[]=[];
 if(typeof generation.duration==='number'&&generation.duration<=0)issues.push({code:'INVALID_DURATION',severity:'error',overridable:false,message:'生成时长必须大于0秒'});
 if(Array.isArray(capabilities?.durationResolutionMap)&&!capabilities.durationResolutionMap.some((entry:any)=>entry.duration?.includes(generation.duration)&&entry.resolution?.includes(generation.resolution)))issues.push({code:'UNSUPPORTED_VIDEO_SETTINGS',severity:'error',overridable:false,message:'当前模型不支持所选时长与清晰度组合',suggestion:'在视频参数中选择该模型支持的时长和清晰度'});
 if(generation.audio&&capabilities?.audio===false)issues.push({code:'AUDIO_UNSUPPORTED',severity:'error',overridable:false,message:'当前模型不支持生成音频',suggestion:'关闭音频或选择支持音频的模型'});
 return issues;
}
