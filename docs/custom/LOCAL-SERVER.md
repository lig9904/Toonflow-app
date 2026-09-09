# 本地服务器 + PostgreSQL + NAS

适用范围：最多 5 人同时操作；视频、图片和文本模型通过已配置的 API 执行，本机不部署生成大模型。以下为配置建议，尚未进行 5 人真实素材负载测试。

| 项目 | 建议 |
| --- | --- |
| CPU | 4 vCPU，现代 x86-64 处理器 |
| 内存 | 16GB；8GB 可作为轻负载起点 |
| 本地 SSD | 80–100GB 起，放操作系统、应用、PostgreSQL 数据及日志 |
| NAS | 独立媒体目录存图片、视频；独立备份目录存数据库备份 |
| 局域网 | 1GbE 有线起步；频繁搬运大视频可用 2.5GbE |
| GPU | 当前 API 生成架构无需 GPU |
| 数据库 | PostgreSQL 18.6，应用专用账号和数据库 |

一台 Linux 虚拟机即可承载应用与 PostgreSQL；不要求拆成两台服务器。应用保持一个 Node 进程，数据库连接池最大 10，持久视频任务默认最多同时处理 2 个。配置建议不等于允许所有人无上限批量生成。

## 数据目录

```text
服务器本地 SSD
  /srv/toonflow/data          应用资源、Provider、模型和运行数据
  /var/lib/postgresql/...    PostgreSQL 数据目录

NAS 挂载
  /mnt/nas/toonflow/media    图片、视频和缩略图
  /mnt/nas/toonflow/backups  pg_dump 等一致性备份
```

PostgreSQL 的活动数据目录放服务器本地 SSD，NAS 用于媒体。若另有成熟数据库服务器，可以通过 DATABASE_URL 连接它。当前已验证真实 NFSv4.1 媒体读写，数据库仍使用本地磁盘；数据库 NAS 异盘备份尚待配置。

## 应用配置

```sh
DATABASE_URL=postgresql://toonflow:CHANGE_ME@127.0.0.1:5432/toonflow
TOONFLOW_DATA_DIR=/srv/toonflow/data
TOONFLOW_MEDIA_DIR=/mnt/nas/toonflow/media
TOONFLOW_HOST=127.0.0.1
TOONFLOW_PORT=10588
NODE_ENV=prod
```

这是配置示例，密码和路径必须使用本地实际配置；不要将真实连接串提交仓库。运行时只接受 PostgreSQL URL，要求 18.6 或后续 18.x 补丁版本；缺少 DATABASE_URL 会停止启动，不回退 SQLite。

NAS 必须先在宿主系统挂载好。确认 media 目录确实位于 NAS 后，在该目录创建空文件 `.toonflow-media-root`。应用验证目录与标记，不会在挂载缺失时主动创建一个本地替代目录。此保护不能代替系统挂载服务及实际断网恢复测试。

构建使用 Node 22、Yarn 1.22.22。先构建 Toonflow-web，将 dist 放入应用 data/web；后端 `yarn build` 后使用 `yarn start`，默认启动新构建的 `build/server.cjs`。前置反向代理负责内网访问、TLS、WebSocket 和静态内容压缩。当前定制版已在 Linux 服务器部署并接入 NFSv4.1 与独立反向代理集群；具体地址和凭据不放入公开仓库。

## 备份与维护

使用 PostgreSQL 的一致性备份工具，备份完成后写入 NAS；不要把正在运行的数据库文件目录直接复制当成完整备份。整库恢复与清空走独立维护流程，原网页中的整库导入/清空已停止用于 PostgreSQL。表概览和逻辑数据导出可用。

数据库引擎升级不会自动补齐团队权限。当前已验证项目 owner 与受限 Agent 范围；完整的创作者、审核员、管理员和项目成员体系仍需继续完善后再开放多人使用。
