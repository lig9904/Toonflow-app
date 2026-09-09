# Seedance 2.5 中转适配

核对时间：2026-09-09。

## 公开来源

- [Seedance NZ API 文档](https://api.seedance.nz/docs/)：`POST /v1/videos` 创建任务，`GET /v1/videos/{task_id}` 查询；成功创建返回 `id`，终态 `completed` 的视频地址位于 `metadata.url`。
- [Seedance NZ 模型目录](https://api.seedance.nz/docs/#models)：Seedance 2.5 只有 Standard 国内/海外线路，共 6 个模型；列出 4–30 秒、六种分辨率和 30/10/10 多模态参考上限。
- [Seedance NZ AI 版文档](https://api.seedance.nz/docs/llms.txt)：与网页模型目录相同，并明确只有智能时长 `-1` 改放到 `metadata.duration=-1`，普通整数秒仍使用顶层字符串 `seconds`。
- [Seedance NZ 公开价格数据](https://api.seedance.nz/api/pricing)：当前目录中 6 个模型均标记为 `openai-video`，默认组可用。它是动态数据，实际扣费以任务终态和控制台余额为准。

## 已适配契约

模型名严格限定为：

```text
seedance-2.5-standard-t2v
seedance-2.5-standard-i2v
seedance-2.5-standard-multi
seedance-2.5-global-standard-t2v
seedance-2.5-global-standard-i2v
seedance-2.5-global-standard-multi
```

没有添加不存在的 Fast 或 Mini 别名。6 个模型都复用 Seedance NZ 的持久任务协议：创建只执行一次并保存 `id`，之后仅查询 `/v1/videos/{task_id}`，创建响应不确定时不自动重建付费任务。

普通时长支持 4–30 秒整数，请求体使用 `seconds: "4"` 到 `seconds: "30"`。Toonflow 当前视频配置契约只提供正整数时长，因此这次没有向界面暴露 `-1` 智能时长。若以后扩展核心配置类型，`-1` 必须省略顶层 `seconds` 并发送 `metadata.duration=-1`。

分辨率严格限定为 `480p`、`720p`、`1080p`、`2k`、`4k`、`native1080p`；2.5 不支持 `native4k`。画幅继续使用 `adaptive`、`16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`，音频开关映射为 `metadata.generate_audio`。

T2V 只接受文本。I2V 使用顶层 `images`，第 1 张是首帧，第 2 张是可选尾帧。Multi 使用 `metadata.content`，最多 30 张图片、10 个视频、10 段音频，至少一个参考；素材按 Toonflow `referenceList` 原顺序提交，每种媒体的 `@图片N`、`@视频N`、`@音频N` 会映射为 API 使用的 `@Image N`、`@Video N`、`@Audio N`。

文档还规定 2.5 Multi 单段参考视频/音频为 2–30 秒且两类总时长不超过 30 秒。provider 运行环境收到的是 base64 内容，没有可信媒体时长元数据，也不能调用本地探测器，所以该限制由上游上传/生成接口最终校验；文件类型、大小与数量会在首次网络请求前校验。

## 兼容边界

Seedance 2.0 的 18 个原模型仍保持 4–15 秒、`480p`/`720p`/`1080p` 和 9 图/3 视频/3 音频边界。图片任务仍使用独立的 `/v1/image/generations` 提交与查询协议，没有与视频任务混用。

6 个模型的元数据、参数和提交/查询契约已做文档核对与本地模拟验证。yd.4.2 已统一部署（真实视频生成在 yd.4.1 完成，最终升级后同键重放仍复用原任务），并通过国内 Standard T2V 的一次真实验收：请求 4 秒、480p、无音频，返回 854×480、4.041667 秒，持久任务成功且 HTTPS/NAS 文件一致；上游视频实扣 ¥2.691562。其余 5 个新变体没有单独发起付费生成。详见 [BUILTIN-RELEASE.md](BUILTIN-RELEASE.md)。
