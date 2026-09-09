import { once } from "node:events";
import { createGatewayClient, ToonflowMcpServer } from "../src/mcp/server";

async function main() {
  const request = createGatewayClient({
    baseUrl:
      process.env.TOONFLOW_AGENT_BASE_URL || "http://127.0.0.1:10588/api/agent",
    token: process.env.TOONFLOW_AGENT_TOKEN || "",
  });
  const server = new ToonflowMcpServer(
    request,
    process.env.TOONFLOW_AGENT_ALLOW_STORYBOARD_WRITE === "1",
  );
  process.stdin.setEncoding("utf8");
  let pending = "";
  for await (const chunk of process.stdin) {
    pending += chunk;
    if (Buffer.byteLength(pending) > 1024 * 1024)
      throw new Error("MCP input exceeds 1 MiB");
    let index: number;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (!line.trim()) continue;
      let result: unknown;
      try {
        result = await server.handle(JSON.parse(line));
      } catch {
        result = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        };
      }
      if (
        result !== undefined &&
        !process.stdout.write(JSON.stringify(result) + "\n")
      )
        await once(process.stdout, "drain");
    }
  }
}
main().catch((error) => {
  process.stderr.write(
    (error instanceof Error ? error.message : "MCP startup failed") + "\n",
  );
  process.exitCode = 1;
});
