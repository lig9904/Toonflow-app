# 受限 Agent API / MCP

服务端凭证独立于网页登录 JWT。未完整配置以下环境变量时 `/api/agent` 返回 503；不会自动开放。

| 变量 | 作用 |
| --- | --- |
| TOONFLOW_AGENT_TOKEN | 至少 32 个字符的专用随机凭证 |
| TOONFLOW_AGENT_USER_ID | 已存在的 owner 用户 ID |
| TOONFLOW_AGENT_PROJECT_IDS | 允许访问的项目 ID，逗号分隔 |
| TOONFLOW_AGENT_ALLOW_STORYBOARD_WRITE | 可选，设为 1 才允许分镜文字写入 |

默认可列出限定项目、剧集，读取制作状态、分镜和视频任务。写入需 expectedVersion、reason、idempotencyKey，在同一 PostgreSQL 事务中更新分镜并记录审计。Agent 不能审核、解锁、生成媒体，也不能访问数据库维护及 Provider 设置接口。

## stdio MCP

后端 `yarn build` 生成 `build/toonflow-mcp.cjs`。MCP 客户端用 Node 22 直接启动该文件的绝对路径，不依赖客户端工作目录：

```text
command: /absolute/path/to/node
args: ["/absolute/path/to/Toonflow-app/build/toonflow-mcp.cjs"]
```

客户端环境配置 `TOONFLOW_AGENT_BASE_URL`（例如 `http://127.0.0.1:10588/api/agent`）和 `TOONFLOW_AGENT_TOKEN`。要显示写工具，还须客户端与服务器两端都配置 `TOONFLOW_AGENT_ALLOW_STORYBOARD_WRITE=1`。远程 URL 必须 HTTPS；HTTP 限 loopback。凭证只发给指定网关，禁止重定向转发。

该适配器按 MCP 2025-03-26 / 2024-11-05 的 stdio 生命周期实现初始化、工具枚举和调用。stdout 只输出 JSON-RPC。直接启动 bundle 可避免包管理器横幅污染协议。

参考：[MCP stdio](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)、[生命周期](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle)、[工具协议](https://modelcontextprotocol.io/specification/2025-03-26/server/tools)。

已完成真实 stdio 进程与本地应用的联调；没有改动用户 Codex 的全局 MCP 配置，也没有对真实项目开放 Agent 凭证。
