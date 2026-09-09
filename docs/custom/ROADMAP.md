# 后续验收顺序

当前已实现 PostgreSQL 18.6 运行时、服务端分镜与资产/图片操作、版本及锁、持久视频任务与重启查询、受限 Agent API/MCP、NAS 媒体目录分离。当前实证见 POSTGRES-VALIDATION.md。

1. 本地服务器部署已完成：PostgreSQL 18.6 使用本地数据盘，媒体使用独立 NAS 目录。通用部署方式见 LOCAL-SERVER.md；包含主机地址的运维记录仅在本地保存。
2. 多模型中转 TS 插件已完成首版，预置文本 8、图片 4、视频 18 个模型，并已验证导入与模拟任务恢复；本地 mock 上游合同见 `providers/README.md` 和 validation 记录。
3. 2026-09-09 已完成 1 张 Seedream 1K 图片和 1 段 Seedance Mini I2V 5 秒 480p 视频的受控实测，NAS 保存和网页播放通过；审核、返工、生产故障恢复和多人权限仍未完成。
4. 开放五人使用前，完善团队成员、角色和项目授权、密钥保护及 HTTPS；增加数据库 NAS 异盘备份，并补充真实 NAS 断网测试。当前 owner 与 Agent 范围检查不是完整团队 RBAC。
5. 自定义视频插件可通过 persistentVideoTaskVersion=1 和 submitVideoTask/queryVideoTask 接入持久恢复；旧 Volcengine 继续兼容。只有 videoRequest 的旧插件仍不能作为可恢复任务使用。
6. 继续扩展剧本、资产与轨道的版本控制；图片生成中断不会自动重复调用模型。
7. 暂不引入 TF-Router 或额外队列平台。

用户服务器部署、真实 NAS 读写、挂载丢失保护与重新挂载恢复已验证；完整五人工作负载测试尚未执行。
