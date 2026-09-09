import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayClient, ToonflowMcpServer } from "../src/mcp/server";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import http from "node:http";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};
test("MCP initialization, validation, unavailable tool and controlled write capability", async () => {
  const calls: string[] = [];
  const rpc = new ToonflowMcpServer(async (path, args) => {
    calls.push(path);
    return path === "capabilities" ? { storyboardWrite: true } : args;
  });
  assert.equal(
    ((await rpc.handle({ jsonrpc: "2.0", id: 0, method: "tools/list" })) as any)
      .error.code,
    -32000,
  );
  assert.equal(
    ((await rpc.handle(initialize)) as any).result.protocolVersion,
    "2025-03-26",
  );
  assert.equal(
    await rpc.handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    undefined,
  );
  const tools = (
    (await rpc.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any
  ).result.tools;
  assert.equal(tools.length, 5);
  assert(tools.every((t: any) => t.annotations.readOnlyHint));
  assert.equal(
    (
      (await rpc.handle({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "toonflow_update_storyboard", arguments: {} },
      })) as any
    ).error.code,
    -32602,
  );
  assert.equal(
    (
      (await rpc.handle({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "toonflow_get_flow",
          arguments: { projectId: 1, scriptId: 2, actor: "human" },
        },
      })) as any
    ).error.code,
    -32602,
  );
  assert.deepEqual(calls, ["capabilities"]);
});
test("MCP upstream errors stay bounded and do not expose credentials", async () => {
  assert.throws(
    () =>
      createGatewayClient({
        baseUrl: "http://example.com/api/agent",
        token: "x".repeat(40),
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createGatewayClient({
        baseUrl: "https://user:secret@example.com/",
        token: "x".repeat(40),
      }),
    /credentials/,
  );
  const rpc = new ToonflowMcpServer(async (path) => {
    if (path === "capabilities") return {};
    throw Error("token=private-secret-in-error");
  });
  await rpc.handle(initialize);
  await rpc.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  const result = await rpc.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "toonflow_get_projects", arguments: {} },
  });
  assert.equal((result as any).result.isError, true);
  assert.equal(JSON.stringify(result).includes("private-secret"), false);
});
test("actual stdio process emits only JSON-RPC and calls authenticated HTTP without a browser", async () => {
  const token = "test-mcp-service-credential-1234567890";
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: req.url?.endsWith("capabilities")
          ? { storyboardWrite: false }
          : [{ id: 100, name: "allowed" }],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  assert(address && typeof address !== "string");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/toonflow-mcp.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TOONFLOW_AGENT_BASE_URL: `http://127.0.0.1:${address.port}/api/agent`,
        TOONFLOW_AGENT_TOKEN: token,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const pending = new Map<number, (value: any) => void>();
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    pending.get(value.id)?.(value);
  });
  const send = (value: any) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("stdio response timed out")),
        5000,
      );
      pending.set(value.id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      child.stdin.write(JSON.stringify(value) + "\n");
    });
  try {
    assert.equal(
      (await send(initialize)).result.serverInfo.name,
      "toonflow-scoped-agent",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    const result = await send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "toonflow_get_projects", arguments: {} },
    });
    assert.deepEqual(JSON.parse(result.result.content[0].text), [
      { id: 100, name: "allowed" },
    ]);
    assert.equal(stderr.includes(token), false);
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("stdio did not exit on EOF")),
        5000,
      );
      child.once("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(Error("stdio process failed"));
      });
    });
  } finally {
    child.kill();
    lines.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
