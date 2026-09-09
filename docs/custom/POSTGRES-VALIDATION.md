# PostgreSQL 迁移验证 · 2026-09-09

本页替代第一轮 SQLite 骨架的当前状态说明。用户已确定使用本地服务器、NAS 媒体存储和 PostgreSQL，最多 5 人。

## 已完成

- 运行时切为 PostgreSQL，DATABASE_URL 必填，不回退 SQLite。
- PG bigint / identity 自增 ID、毫秒时间、安全 JS number 解析、显式关联顺序。
- PG 事务锁、版本 CAS、锁定触发器、审核状态、幂等审计及视频任务持久化。
- 项目、剧本、分镜等消费 INSERT ID 的路径使用显式 RETURNING。
- SQLite 驱动仅保留在开发依赖，供既有回归测试使用。旧 db2.sqlite 文件未删除，也没有把它自动导入 PG。
- 媒体目录可单独指向 NAS，应用数据和 PostgreSQL 活动数据保持本地磁盘。
- 前端原有 19 项类型错误已清零，完整 type-check 与构建通过。
- Agent 资产与图片操作改为服务端执行，HTTP 完成校验及 claim 后返回 202，后台完成持久状态。
- 提供受项目范围限制的 Agent API 和独立 stdio MCP bundle。

## 实证

最终目标及隔离实测版本：PostgreSQL 18.6。早期 17.11 测试只保留为历史记录；最终结论已在 18.6 独立实例重跑。测试在随机 schema 中执行，未连接任何用户生产数据库。

全量回归覆盖 PG 与既有回归用例。PG 专项包括双连接同版本仅一方成功、原始写锁保护、审核回退、事务回滚、幂等任务、分镜顺序、小数时长、PG Agent 写入审计。定制发行版 1.1.8-yd.1 的全量测试为 87/87 通过，见 `validation/custom-release-tests.txt`；`postgres-all-tests.txt` 保留为较早的 PG 迁移记录。旧 SQLite 回归只是额外历史检查，不能替代 PG 测试。

真实应用通过 HTTP 创建项目、剧本、分镜，并验证 duration=5.5。随后连接本地模拟上游：创建请求总计 1 次，第一次查询为运行中；终止 Node 进程再启动，使用同一 upstreamTaskId 查询完成并写入独立媒体目录。最终 job=SUCCEEDED。该文件是模拟字节，不是实际视频成片。

重启测试发现并修复了 PG 触发器重复创建问题；现在函数和触发器安装在同一事务中，重复启动保留锁保护。

原始记录在 `validation/postgres-all-tests.txt` 和 `validation/postgres-restart-smoke.json`。本机没有模拟出真实 NAS 网络、五人素材吞吐或断电行为，因此没有宣称这些现场条件已经通过。

媒体引用的 base64 正文只在提交前短暂保留；取得上游任务 ID 或进入终态/人工核对后，数据库中只保留类型和哈希摘要，避免长期将 NAS 媒体再复制进 PostgreSQL。幂等校验使用原始请求哈希，首次实际提交仍携带完整引用。

## 下一步

1. 本地服务器、PostgreSQL 18.6、真实 NFSv4.1 媒体目录和 HTTPS 反向代理集群已部署，通用说明见 LOCAL-SERVER.md。
2. 完善团队成员、角色、密钥保护和备份恢复验收。
3. 配置 Seedance 中转文档、模型名与本地凭证，做受控真实生成测试。当前无付费调用和真实成片证据。
4. 当前持久视频入口仅支持带 submit/query 的 volcengine 适配器；其他 Provider 返回不支持恢复的明确错误，尚未统一迁移。

定制源码在 `custom/main` 维护，1.1.8-yd.1 已部署到用户服务器。原作者更新清单和在线下载安装入口已停用，更新须经代码审查、测试、构建和管理员部署。
