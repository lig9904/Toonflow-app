import test from "node:test";
import assert from "node:assert/strict";
import { decodeAndValidateInlineImage } from "../src/services/imageJobs/inlineImage";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("sync image data URI is strictly decoded and sharp validated", async () => {
  const bytes = await decodeAndValidateInlineImage(`data:image/png;base64,${png}`);
  assert.ok(bytes.length > 0);
  await assert.rejects(decodeAndValidateInlineImage(`data:image/jpeg;base64,${png}`), /格式不一致/);
  await assert.rejects(decodeAndValidateInlineImage(`data:image/png;base64,${png.slice(0, -40)}`), /解码|可解码|corrupt|Input buffer/);
  await assert.rejects(decodeAndValidateInlineImage("data:image/png;base64,AAAA!"), /data URI|base64/);
});
