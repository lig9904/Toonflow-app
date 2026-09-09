# 本地运行

当前数据库已改为 PostgreSQL 18.6。先按 LOCAL-SERVER.md 配置 DATABASE_URL 和可选 NAS 媒体路径，再启动应用；不再使用 SQLite。前端类型检查已清零，最新验证见 POSTGRES-VALIDATION.md，下面的早期测试记录不作为当前数据库结论。

验证环境为 Node 22（`.nvmrc`），Yarn 1.22.22。可使用 nvm，或 `npx --yes --package=node@22 --package=yarn@1.22.22 yarn ...`。两仓库分别安装 `yarn install --frozen-lockfile`；后端可设置 ELECTRON_SKIP_BINARY_DOWNLOAD=1 跳过桌面二进制。

后端检查：`yarn lint`、`yarn test:custom`、`yarn build`。PG 测试还需配置独立的 TOONFLOW_TEST_DATABASE_URL。前端完整检查与打包使用 `yarn build`。后端 build 会先生成路由，服务器入口为 `build/server.cjs`，MCP 入口为 `build/toonflow-mcp.cjs`。

生产 bundle 运行前，应把配套 Toonflow-web/dist 的内容复制到服务器数据目录的 web 子目录，并保留 assets、models、modelPrompt、skills、vendor。源码开发可用 `NODE_ENV=dev yarn dev`，构建后启动用 `NODE_ENV=prod yarn start`。

- TOONFLOW_DATA_DIR：可选，绝对数据目录；未设置保持上游 cwd/data。
- TOONFLOW_HOST：默认 127.0.0.1。需要跨主机访问时再显式配置绑定地址和访问控制。
- TOONFLOW_PORT：默认 10588。

早期验证单独使用工作区 `.local/runtime/data` 数据库和无模型的合成项目，避免使用真实项目或模型配置。首次建库仍以 admin/admin123 初始化，部署到可访问网络前必须通过受控初始化流程设置随机密码。当前登录会将旧明文密码升级为 scrypt；新密码禁止 admin123，JWT 默认有效期为 8 小时。完整团队权限仍待补齐。

接口凭证不写源码、不贴聊天、不放浏览器测试输出。Seedance mock 测试不访问远端，不产生费用。
