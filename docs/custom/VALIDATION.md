# 第一阶段历史验证记录 · 2026-09-09

本页保留早期 SQLite 阶段的结果，不代表当前发行版状态。当前 PostgreSQL 18.6、前端检查与部署结果见 POSTGRES-VALIDATION.md 和 LOCAL-SERVER.md。

已完成双仓库本地开发基线、Seedance 媒体修复和分镜协作纵切。使用两路 GPT-5.6 Luna 处理媒体与界面、一路 GPT-5.6 Terra 处理事务，主代理独立复核并修复接线问题。修改未提交、未推送、未正式部署。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| 后端 Node 22，tsx --test tests/*.test.ts | 30/30 通过 |
| 后端 tsc --noEmit | 通过 |
| 后端构建，含重新生成路由 | 通过 |
| 前端 vite build | 通过 |
| 前后端 git diff --check | 通过 |
| 前端全量 vue-tsc | 仍有 19 项上游既有错误 |

前端独立基线使用 HEAD archive、相同 node_modules，并先修复原有 computed 语法错误及 TS5.6 不兼容的 ignoreDeprecations 配置，以展开类型检查。基线有 21 项类型错误，本轮修复其中两项；最终工作树有 19 项，与其余基线错误一致，新增 0。原始日志在 validation/web-typecheck-baseline.txt 和 web-typecheck-current.txt。前端打包成功不等于完整类型检查通过。

后端覆盖 Provider mock 协议、关系表事实源、项目归属、两独立 SQLite 连接版本冲突、锁保护原表及关联写、事务回滚、重开持久化、HTTP 鉴权、规划 CAS、跨项目及稀疏分镜排序。明细在 validation/backend-tests.txt。

## 真实本地应用验证

使用独立 .local/runtime/data/db2.sqlite 与合成项目，启动源码服务和最终构建 bundle，验证登录、读取分镜、HTTP 编辑和真实 Socket.IO。浏览器测试注入无模型的本地项目选择状态，以检查非生成操作；没有配置或调用收费模型。

- 另一客户端先保存后，当前弹窗返回 409，未保存文字保留。截图：validation/conflict-preserves-draft.png。
- 人工审核后锁定，文字、视频描述、审核与提交按钮禁用，可由持有人解锁。截图：validation/locked-storyboard.png。
- Socket.IO 跨项目连接被断开，跨项目 updateContext 被拒绝，合法项目上下文被接受。
- 服务端通过共享新增服务提交分镜后，浏览器收到无 storyboardId 的变更通知并自动显示新分镜，无需手动刷新。
- 浏览器验证发现并修复上游数据库包装的运行时缺陷：Object.assign 丢失非枚举 transaction 方法。现在保留真实 Knex 实例，应用中事务调用可用。
- 构建产物与运行时可写素材目录分离，避免 bootstrap 改写源码 provider 模板。

## 证据边界

尚未获得中转接口文档、实际 baseUrl、模型名与测试配置。Provider 测试均为本地 mock，没有真实 Seedance 生成、费用或成片证据。重启续作、剩余 Agent 回调迁移、MCP、完整团队权限与密钥保护、正式部署仍在 ROADMAP.md。

无模型环境会显示模型未配置提示；浏览器会记录上游 Electron 私有 URL scheme 探测错误。这些不影响上述非生成操作，但也不能视为生成流程已通过。
