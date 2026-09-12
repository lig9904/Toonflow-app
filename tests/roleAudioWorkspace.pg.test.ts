import {readProductionFlow} from "../src/services/productionFlow";
import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { ensureProductionStateSchema } from "../src/services/productionState";
import {
  applyAudioMatchProposal,
  ensureRoleAudioWorkspaceSchema,
  prepareAudioMatchContext,
  readBoundAudioReferences,
  readRoleVoiceCasting,
  saveRoleAudioBinding,
  saveRoleAudioBindings,
  startAudioMatchRun,
} from "../src/services/roleAudioWorkspace";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const actor = { id: "human:1", kind: "human" as const };
const code = (wanted: string) => (error: unknown) => (error as { code?: unknown })?.code === wanted;

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureRoleAudioWorkspaceSchema(f.db);
  await ensureProductionStateSchema(f.db);
  const [project] = await f.db("o_project").insert({ name: "audio", userId: 1 }).returning("id");
  const [otherProject] = await f.db("o_project").insert({ name: "other", userId: 1 }).returning("id");
  const projectId = Number(project.id), otherProjectId = Number(otherProject.id);

  async function asset(values: Record<string, unknown>) {
    const [row] = await f.db("o_assets").insert({ projectId, ...values }).returning("id");
    const id = Number(row.id);
    await f.db("ext_creative_state").insert({ entityType: "asset", entityId: id, projectId: Number(values.projectId ?? projectId), version: 1, updatedBy: actor.id, updatedAt: 1 });
    return id;
  }
  async function audioFamily(name: string) {
    const familyId = await asset({ type: "audio", name });
    const childId = await asset({ type: "audio", name: `${name} child`, assetsId: familyId, prompt: `${name} prompt` });
    const [image] = await f.db("o_image").insert({ assetsId: childId, type: "audio", filePath: `/${name}.mp3`, state: "已完成" }).returning("id");
    await f.db("o_assets").where({ id: childId }).update({ imageId: Number(image.id) });
    return { familyId, childId };
  }

  const roleId = await asset({ type: "role", name: "Hero" });
  const derivedRoleId = await asset({ type: "role", name: "Hero older", assetsId: roleId });
  const sceneId = await asset({ type: "scene", name: "Street" });
  const firstAudio = await audioFamily("voice-a");
  const secondAudio = await audioFamily("voice-b");
  const foreignAudio = await asset({ projectId: otherProjectId, type: "audio", name: "foreign" });
  return { ...f, projectId, otherProjectId, roleId, derivedRoleId, sceneId, firstAudio, secondAudio, foreignAudio };
}

test("manual role-audio binding normalizes child selection, preserves omission, clears explicitly, and emits playable child references", options, async () => {
  const f = await fixture();
  try {
    const bound = await saveRoleAudioBinding(f.db, {
      projectId: f.projectId, roleAssetId: f.roleId, expectedVersion: 1,
      audioIds: [f.firstAudio.childId], audioVersions: [{ id: f.firstAudio.childId, expectedVersion: 1 }], idempotencyKey: "manual-audio-bind",
    }, actor);
    assert.equal(bound.binding.version, 2);
    assert.deepEqual(bound.binding.audioFamilies.map((item: any) => item.id), [f.firstAudio.familyId]);
    const links = await f.db("o_assetsRole2Audio").where({ assetsRoleId: f.roleId });
    assert.deepEqual(links.map((row) => Number(row.assetsAudioId)), [f.firstAudio.familyId]);

    const omitted = await saveRoleAudioBinding(f.db, {
      projectId: f.projectId, roleAssetId: f.roleId, expectedVersion: 2, idempotencyKey: "manual-audio-preserve",
    }, actor);
    assert.equal(omitted.binding.version, 2);
    assert.deepEqual(omitted.binding.audioFamilies.map((item: any) => item.id), [f.firstAudio.familyId]);

    const refs = await readBoundAudioReferences(f.db, f.projectId, [f.roleId]);
    assert.deepEqual(refs.map((item) => ({ roleAssetId: item.roleAssetId, familyId: item.familyId, id: item.id, filePath: item.filePath })), [
      { roleAssetId: f.roleId, familyId: f.firstAudio.familyId, id: f.firstAudio.childId, filePath: "/voice-a.mp3" },
    ]);

    const cleared = await saveRoleAudioBinding(f.db, {
      projectId: f.projectId, roleAssetId: f.roleId, expectedVersion: 2,
      audioIds: [], audioVersions: [], idempotencyKey: "manual-audio-clear",
    }, actor);
    assert.equal(cleared.binding.version, 3);
    assert.deepEqual(cleared.binding.audioFamilies, []);
    const replay = await saveRoleAudioBinding(f.db, {
      projectId: f.projectId, roleAssetId: f.roleId, expectedVersion: 2,
      audioIds: [], audioVersions: [], idempotencyKey: "manual-audio-clear",
    }, actor);
    assert.equal(replay.reused, true);
  } finally { await f.destroy(); }
});

test("binding rejects foreign, wrong-type and multiple-family inputs without clearing the old binding", options, async () => {
  const f = await fixture();
  try {
    await saveRoleAudioBinding(f.db, {
      projectId: f.projectId, roleAssetId: f.roleId, expectedVersion: 1,
      audioIds: [f.firstAudio.familyId], audioVersions: [{ id: f.firstAudio.familyId, expectedVersion: 1 }], idempotencyKey: "initial-audio-bind",
    }, actor);
    const failures = [
      { audioIds: [f.foreignAudio], audioVersions: [{ id: f.foreignAudio, expectedVersion: 1 }], key: "foreign-audio", wanted: "PROJECT_MISMATCH" },
      { audioIds: [f.sceneId], audioVersions: [{ id: f.sceneId, expectedVersion: 1 }], key: "wrong-type-audio", wanted: "TYPE_MISMATCH" },
      { audioIds: [f.firstAudio.childId, f.secondAudio.childId], audioVersions: [{ id: f.firstAudio.childId, expectedVersion: 1 }, { id: f.secondAudio.childId, expectedVersion: 1 }], key: "two-audio-families", wanted: "INVALID_INPUT" },
    ];
    for (const failure of failures) {
      await assert.rejects(saveRoleAudioBinding(f.db, {
        projectId: f.projectId, roleAssetId: f.roleId, expectedVersion: 2,
        audioIds: failure.audioIds, audioVersions: failure.audioVersions, idempotencyKey: failure.key,
      }, actor), code(failure.wanted));
      assert.deepEqual((await f.db("o_assetsRole2Audio").where({ assetsRoleId: f.roleId })).map((row) => Number(row.assetsAudioId)), [f.firstAudio.familyId]);
    }
    await assert.rejects(saveRoleAudioBinding(f.db, {
      projectId: f.projectId, roleAssetId: f.sceneId, expectedVersion: 1,
      audioIds: [], audioVersions: [], idempotencyKey: "wrong-role-type",
    }, actor), code("TYPE_MISMATCH"));

    const derived = await saveRoleAudioBinding(f.db, {
      projectId: f.projectId, roleAssetId: f.derivedRoleId, expectedVersion: 1,
      audioIds: [f.secondAudio.familyId], audioVersions: [{ id: f.secondAudio.familyId, expectedVersion: 1 }], idempotencyKey: "derived-role-bind",
    }, actor);
    assert.equal(derived.binding.audioFamilies[0].id, f.secondAudio.familyId);
  } finally { await f.destroy(); }
});

test("locked storyboards, stale model snapshots and concurrent writers cannot replace a valid binding", options, async () => {
  const f = await fixture();
  try {
    await saveRoleAudioBinding(f.db, {
      projectId: f.projectId, roleAssetId: f.roleId, expectedVersion: 1,
      audioIds: [f.firstAudio.familyId], audioVersions: [{ id: f.firstAudio.familyId, expectedVersion: 1 }], idempotencyKey: "locked-initial-bind",
    }, actor);
    const [storyboard] = await f.db("o_storyboard").insert({ projectId: f.projectId, scriptId: 1, prompt: "locked" }).returning("id");
    await f.db("o_assets2Storyboard").insert({ storyboardId: Number(storyboard.id), assetId: f.roleId });
    await f.db("ext_entity_state").insert({ entityType: "storyboard", entityId: Number(storyboard.id), projectId: f.projectId, version: 0, reviewState: "draft", locked: 1, lockedBy: actor.id })
      .onConflict(["entityType", "entityId"]).merge({ locked: 1, lockedBy: actor.id });
    await assert.rejects(saveRoleAudioBinding(f.db, {
      projectId: f.projectId, roleAssetId: f.roleId, expectedVersion: 2,
      audioIds: [], audioVersions: [], idempotencyKey: "locked-clear-bind",
    }, actor), code("LOCKED"));
    assert.deepEqual((await f.db("o_assetsRole2Audio").where({ assetsRoleId: f.roleId })).map((row) => Number(row.assetsAudioId)), [f.firstAudio.familyId]);
    await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: Number(storyboard.id) }).update({ locked: 0, lockedBy: null });

    const context = await prepareAudioMatchContext(f.db, {
      projectId: f.projectId, items: [{ roleAssetId: f.roleId, expectedVersion: 2 }], idempotencyKey: "model-context",
    });
    const selected = context.candidates.find((item) => item.familyId === f.secondAudio.familyId)!;
    await f.db("ext_creative_state").where({ entityType: "asset", entityId: selected.children[0].id }).update({ version: 2 });
    await assert.rejects(applyAudioMatchProposal(f.db, {
      projectId: f.projectId,
      items: [{
        roleAssetId: f.roleId, expectedVersion: 2, audioIds: [selected.familyId],
        audioVersions: [{ id: selected.familyId, expectedVersion: selected.version }],
        audioFamilySnapshot: { familyId: selected.familyId, expectedVersion: selected.version, children: selected.children.map((child) => ({ id: child.id, expectedVersion: child.version })) },
      }],
      idempotencyKey: "late-model-audio",
    }, { id: "agent:audio", kind: "agent" }), code("VERSION_CONFLICT"));
    assert.deepEqual((await f.db("o_assetsRole2Audio").where({ assetsRoleId: f.roleId })).map((row) => Number(row.assetsAudioId)), [f.firstAudio.familyId]);

    await saveRoleAudioBinding(f.db, {
      projectId: f.projectId, roleAssetId: f.roleId, expectedVersion: 2,
      audioIds: [], audioVersions: [], idempotencyKey: "clear-before-concurrent",
    }, actor);

    const attempts = await Promise.allSettled([f.firstAudio.familyId, f.secondAudio.familyId].map((audioId, index) => saveRoleAudioBindings(f.db, {
      projectId: f.projectId,
      items: [{ roleAssetId: f.roleId, expectedVersion: 3, audioIds: [audioId], audioVersions: [{ id: audioId, expectedVersion: 1 }] }],
      idempotencyKey: `concurrent-audio-${index}`,
    }, actor)));
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  } finally { await f.destroy(); }
});

test("requesting model matching is a separate action and never reports completion without a builtin runtime receipt", options, async () => {
  const f = await fixture();
  try {
    const before = await f.db("o_assetsRole2Audio").where({ assetsRoleId: f.roleId });
    await assert.rejects(startAudioMatchRun(f.db, {
      projectId: f.projectId, items: [{ roleAssetId: f.roleId, expectedVersion: 1 }], idempotencyKey: "audio-runtime-required",
    }, 1), code("RUNTIME_UNAVAILABLE"));
    assert.deepEqual(await f.db("o_assetsRole2Audio").where({ assetsRoleId: f.roleId }), before);
    assert.equal((await f.db("o_assets").where({ id: f.roleId }).first()).audioBindState, null);
  } finally { await f.destroy(); }
});

test("fixed voice keeps one clip across additions, supports explicit replacement and rejects changed source", options, async()=>{
 const f=await fixture();try{
  await saveRoleAudioBinding(f.db,{projectId:f.projectId,roleAssetId:f.roleId,expectedVersion:1,audioIds:[f.firstAudio.familyId],audioVersions:[{id:f.firstAudio.familyId,expectedVersion:1}],idempotencyKey:"pin-first-voice"},actor);
  const [child]=await f.db("o_assets").insert({projectId:f.projectId,type:"audio",assetsId:f.firstAudio.familyId,name:"different take"}).returning("id");
  const [media]=await f.db("o_image").insert({assetsId:child.id,type:"audio",filePath:"/other-take.mp3",state:"已完成"}).returning("id");await f.db("o_assets").where({id:child.id}).update({imageId:media.id});
  await f.db("ext_creative_state").insert({entityType:"asset",entityId:child.id,projectId:f.projectId,version:1,updatedBy:actor.id,updatedAt:1});
  assert.deepEqual((await readBoundAudioReferences(f.db,f.projectId,[f.roleId])).map(x=>x.id),[f.firstAudio.childId]);
  const changed=await saveRoleAudioBinding(f.db,{projectId:f.projectId,roleAssetId:f.roleId,expectedVersion:2,audioIds:[Number(child.id)],audioVersions:[{id:Number(child.id),expectedVersion:1}],idempotencyKey:"pin-second-voice"},actor);
  assert.equal(changed.binding.version,3);assert.equal(changed.binding.audioFamilies[0].voiceReference.id,Number(child.id));assert.equal(changed.binding.audioFamilies[0].voiceOptions.length,2);
  await f.db("o_image").where({id:media.id}).update({filePath:"/changed.mp3"});
  await assert.rejects(()=>readBoundAudioReferences(f.db,f.projectId,[f.roleId]),code("VERSION_CONFLICT"));
 }finally{await f.destroy();}
});

test("derived characters inherit the fixed voice unless explicitly given their own", options, async()=>{
 const f=await fixture();try{
  await saveRoleAudioBinding(f.db,{projectId:f.projectId,roleAssetId:f.roleId,expectedVersion:1,audioIds:[f.firstAudio.childId],audioVersions:[{id:f.firstAudio.childId,expectedVersion:1}],idempotencyKey:"inherit-parent-voice"},actor);
  assert.equal((await readRoleVoiceCasting(f.db,f.projectId,[f.derivedRoleId]))[0].audioId,f.firstAudio.childId);
  await saveRoleAudioBinding(f.db,{projectId:f.projectId,roleAssetId:f.derivedRoleId,expectedVersion:1,audioIds:[f.secondAudio.childId],audioVersions:[{id:f.secondAudio.childId,expectedVersion:1}],idempotencyKey:"inherit-own-voice"},actor);
  assert.equal((await readRoleVoiceCasting(f.db,f.projectId,[f.derivedRoleId]))[0].audioId,f.secondAudio.childId);
 }finally{await f.destroy();}
});

import {canUseScriptAsset} from '../src/services/scriptReferenceAccess';
import {resolveVideoReferencePurposes} from '../src/services/videoModeResolution';
import {loadOwnedVideoReferences} from '../src/services/videoJobs/request';
test('fixed voice is usable by its character episode without granting unrelated audio access',options,async()=>{
 const f=await fixture();try{
  const [script]=await f.db('o_script').insert({projectId:f.projectId,name:'voice episode'}).returning('id');
  const [other]=await f.db('o_script').insert({projectId:f.projectId,name:'unrelated episode'}).returning('id');
  await f.db('o_scriptAssets').insert({scriptId:script.id,assetId:f.roleId});
  await saveRoleAudioBinding(f.db,{projectId:f.projectId,roleAssetId:f.roleId,expectedVersion:1,audioIds:[f.firstAudio.childId],audioVersions:[{id:f.firstAudio.childId,expectedVersion:1}],idempotencyKey:'episode-voice-bind'},actor);
  assert.equal(await canUseScriptAsset(f.db,f.projectId,Number(script.id),f.firstAudio.childId),true);
  const flow=await readProductionFlow(f.db,f.projectId,Number(script.id),async p=>p);assert.equal(flow.voiceReferences[0].audioId,f.firstAudio.childId);
  assert.equal(await canUseScriptAsset(f.db,f.projectId,Number(other.id),f.firstAudio.childId),false);
  assert.equal(await canUseScriptAsset(f.db,f.projectId,Number(script.id),f.secondAudio.childId),false);
  assert.equal(await canUseScriptAsset(f.db,f.otherProjectId,Number(script.id),f.firstAudio.childId),false);
  const references=[{id:f.firstAudio.childId,sources:'assets' as const,fileType:'audio' as const,purpose:'audio_reference' as const}];
  const resolved=await resolveVideoReferencePurposes(f.db,{projectId:f.projectId,scriptId:Number(script.id),trackId:1,references});assert.equal(resolved[0].fileType,'audio');
  const sent=await loadOwnedVideoReferences(f.db,f.projectId,Number(script.id),references,async path=>'loaded:'+path);assert.equal(sent[0].type,'audio');assert.equal((sent[0] as any).base64,'loaded:/voice-a.mp3');
  await saveRoleAudioBinding(f.db,{projectId:f.projectId,roleAssetId:f.roleId,expectedVersion:2,audioIds:[],audioVersions:[],idempotencyKey:'episode-voice-unbind'},actor);
  assert.equal(await canUseScriptAsset(f.db,f.projectId,Number(script.id),f.firstAudio.childId),false);
 }finally{await f.destroy();}
});
