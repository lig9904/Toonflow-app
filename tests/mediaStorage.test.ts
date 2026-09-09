import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import getPath from "../src/utils/getPath";
import { ensureMediaDirectory, MEDIA_ROOT_MARKER } from "../src/utils/mediaStorage";

test("NAS media override leaves local application data separate", async () => {
  const data=process.env.TOONFLOW_DATA_DIR, media=process.env.TOONFLOW_MEDIA_DIR;
  try {
    process.env.TOONFLOW_DATA_DIR="/srv/toonflow/data"; process.env.TOONFLOW_MEDIA_DIR="/mnt/nas/toonflow";
    assert.equal(getPath("local-state.json"),"/srv/toonflow/data/local-state.json"); assert.equal(getPath("oss"),"/mnt/nas/toonflow");
    process.env.TOONFLOW_MEDIA_DIR="relative-nas";assert.throws(()=>getPath("oss"),/绝对路径/);
  } finally {
    if(data===undefined)delete process.env.TOONFLOW_DATA_DIR;else process.env.TOONFLOW_DATA_DIR=data;
    if(media===undefined)delete process.env.TOONFLOW_MEDIA_DIR;else process.env.TOONFLOW_MEDIA_DIR=media;
  }
});
test("an absent NAS or missing mount marker never creates a local media fallback", async () => {
  const dir=await mkdtemp(path.join(tmpdir(),"toonflow-media-"));const media=path.join(dir,"nas");
  try {
    await assert.rejects(ensureMediaDirectory(media,true),/未就绪/);
    await mkdir(media);await assert.rejects(ensureMediaDirectory(media,true),/未就绪/);
    await writeFile(path.join(media,MEDIA_ROOT_MARKER),"");await ensureMediaDirectory(media,true);
    await rm(path.join(media,MEDIA_ROOT_MARKER));await assert.rejects(ensureMediaDirectory(media,true),/未就绪/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
