import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchVideoBytes } from "../src/services/videoJobs/download";

test("video download deadline covers a stalled body after successful headers", async () => {
  const server = http.createServer((_req,res) => { res.writeHead(200); res.flushHeaders(); res.write("partial body"); });
  await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); assert(address&&typeof address!=="string");
  try { await assert.rejects(fetchVideoBytes(`http://127.0.0.1:${address.port}/video`,40), (error:unknown) => error instanceof Error && error.name==="AbortError"); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve)=>server.close(()=>resolve())); }
});
