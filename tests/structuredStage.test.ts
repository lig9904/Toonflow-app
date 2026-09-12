import test from 'node:test';
import assert from 'node:assert/strict';
import {runStructuredStage} from '../src/services/builtinAgent/structuredStage';
import {StructuredModelOutputError, type StructuredOutputErrorCode} from '../src/lib/structuredModelOutput';
const failure=(code:StructuredOutputErrorCode)=>new StructuredModelOutputError(code,{role:'productionAgent:supervisionAgent',finishReason:'stop',maxOutputTokens:4000,textCharacters:50});
test('one format retry has its own attempt and only returns validated result',async()=>{const attempts:number[]=[];let events=0;const result=await runStructuredStage(async n=>{attempts.push(n);if(!n)throw failure('MODEL_OUTPUT_FORMAT');return{findings:[],summary:'ok'};},async()=>{events++});assert.deepEqual(attempts,[0,1]);assert.equal(events,1);assert.equal(result.summary,'ok')});
test('persistent format error stops after two attempts',async()=>{let calls=0;await assert.rejects(()=>runStructuredStage(async()=>{calls++;throw failure('MODEL_OUTPUT_FORMAT')},async()=>{}));assert.equal(calls,2)});
test('no retry for filter, truncation, interruption, or transport error',async()=>{for(const e of [failure('MODEL_OUTPUT_FILTERED'),failure('MODEL_OUTPUT_LIMIT'),failure('MODEL_OUTPUT_INCOMPLETE'),new Error('network')]){let calls=0;await assert.rejects(()=>runStructuredStage(async()=>{calls++;throw e},async()=>{assert.fail('must not retry')}));assert.equal(calls,1)}});
test('cancellation or exhausted permission before retry prevents another call',async()=>{let calls=0;await assert.rejects(()=>runStructuredStage(async()=>{calls++;throw failure('MODEL_OUTPUT_FORMAT')},async()=>{throw new Error('cancelled')}),/cancelled/);assert.equal(calls,1)});
