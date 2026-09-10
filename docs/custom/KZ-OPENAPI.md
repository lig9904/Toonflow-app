# AI开放平台（KZ）供应商

该供应商（ID：`kzOpenApi`）接入已审阅的 AI 开放平台视频兼容接口 v1.2。它只声明四个视频模型：

- `doubao-seedance-2-0-260128`：Pro，480p / 720p / 1080p / 4k，4–15 秒或 `-1`。
- `doubao-seedance-2-0-fast-260128`：Fast，480p / 720p / 1080p，4–15 秒或 `-1`。
- `doubao-seedance-2-0-mini-260615`：Mini，480p / 720p / 1080p，4–15 秒或 `-1`。
- `doubao-seedance-2-5-260628`：2.5，480p / 720p / 1080p，4–30 秒或 `-1`。

2.5 不显示 4k、2k 或 `native1080p`；4k 只属于 Pro 的原生分辨率能力，超分配置不属于这个兼容供应商的模型质量选项。四个模型均支持文生视频和参考内容，图 / 视频 / 音频上限分别为 9 / 3 / 3；2.5 为 30 / 10 / 10。供应商没有依据这四页资料添加文本、图片生成或 TTS 模型。

## 配置与视频请求

在“模型服务 → 添加供应商 → 通过文件导入”导入 `kzOpenApi.ts` 后，填写平台后台提供的 BASE_URL 和平台 ApiKey。BASE_URL 必须是 HTTPS origin，例如 `https://api.example.com`；代码会拼接：

```text
{BASE_URL}/ai-open-platform-api/api/v3/contents/generations/tasks
{BASE_URL}/ai-open-platform-api/api/v3/contents/generations/tasks/{id}
```

视频创建使用 `Authorization: Bearer <平台 ApiKey>`，查询使用同一 Bearer 头。平台返回的任务 ID（通常带 `kz-cgt-` 前缀）原样保存；提交与查询分别导出，可在重启后继续查询，不会因浏览器或进程超时自动重复 POST。

成功查询优先使用 `content.kz_video_url`，没有时才回退 `content.video_url`。`succeeded` 没有有效 URL、返回未知状态、或 HTTP / 业务错误都会失败；错误信息会脱敏截断，不回显配置密钥。

2.5 的首帧、首尾帧、编辑和延长都必须使用 `ratio=adaptive`。模型元数据会声明 `referenceRatio: "adaptive"`；由于工作台保存的是项目固定画幅，KZ provider 在这些任务中会把固定画幅映射为 `adaptive`，避免界面展示可选比例却提交必然失败。编辑需要 `omni_reference_task_type=edit`、`reference_video` 和 `duration=-1`；延长使用 `omni_reference_task_type=extend`、`reference_video` 和 `ratio=adaptive`；普通参考可使用 `reference`，未指定时为 `auto`。显式任务类型只适用于 2.5。

## 参考素材边界

兼容视频接口的 `content` 只发送文档已承诺的公网 URL 或平台素材引用：

```json
{ "type": "image_url", "role": "reference_image", "image_url": { "url": "https://media.example.com/ref.png" } }
{ "type": "video_url", "role": "reference_video", "video_url": { "url": "asset://1800657071180349888" } }
```

素材类型保持 `image_url`、`video_url`、`audio_url`，引用顺序保持调用方顺序。`asset://<十进制 ID>` 只有在素材已就绪时才可使用。兼容素材入口为：

```text
POST {BASE_URL}/ai-open-platform-api/api/support/v1/asset?Action=<Action>&Version=2024-01-01
```

素材请求使用独立的 `ApiKey: <平台 ApiKey>` 头，不使用视频接口的 Bearer 头。供应商导出素材组和素材的增删改查函数，按 `ResponseMetadata` / `Result` 解包，并保留平台 ID 为字符串。

四页文档只承诺素材 URL 登记和 `asset://ID` 引用，没有承诺 data URI 或二进制上传接口。Toonflow 当前运行时给供应商的本地素材可能是 base64，因此 KZ 请求会使用应用自己的单文件桥接：服务先验证项目、脚本和素材归属，再为该文件签发 HMAC 保护的 HTTPS URL。URL 只绑定当时验证的一个文件快照，不暴露路径或项目 ID；支持视频和音频的 `GET/HEAD/Range`，检查大小、mtime 和文件内容指纹。

桥接 URL 默认最长租约 72 小时，硬上限约 73 小时，适配平台可能长达 2–3 天的排队窗口；同一项目、来源实体、路径和内容指纹复用稳定 token，续期只更新数据库期限。业务幂等 hash 会剔除桥接 token 和过期时间，保留媒体类型、来源和内容指纹。若持久任务重启后文件已经变化，系统会终止重签并保留原任务输入，绝不把用户后来替换的图片/视频/音频悄悄用于原任务。

桥接公网 origin 和持久 secret 必须显式配置：`TOONFLOW_MEDIA_PUBLIC_ORIGIN`、`TOONFLOW_MEDIA_BRIDGE_SECRET`。未配置时，T2V 仍可提交，带本地参考的 KZ 任务会清晰失败。系统不猜测部署网络、不把需要团队会话的 `/oss` URL 交给上游、不猜测平台上传 endpoint，也不会上传或扫描整个 NAS。

## 证据边界

契约测试使用模拟 HTTP 响应，覆盖 URL、鉴权、请求体、模型能力、分辨率和时长边界、2.5 任务类型约束、素材引用、素材协议、错误分类和脱敏。没有调用真实 API、没有产生付费任务，也没有验证平台后台尚未提供的 BASE_URL、账号权限、data URI 兼容性或 NAS 下载链路。

资料来源为 `output/playwright/apifox-review/接口兼容性评估.md`、兼容视频 v1.2（`9230107m0.md`）和兼容素材 v1.0（`9230109m0.md`）。实际 BASE_URL 已由关联的 PCP 管理平台文档确认：`https://aiopenapi.kuaizi.cn`；关联文档入口为 [PCP / 丽帧通用信息查询](https://www.yuque.com/huicundeyouhuo-dtb95/tci6ux/aoma0s69oa5yw7so)。曾用无密钥请求验证该网关返回 `missing ApiKey`，没有发送真实密钥或付费任务。原生视频 / 原生素材资料用于确认能力边界，但本适配器使用兼容入口。
