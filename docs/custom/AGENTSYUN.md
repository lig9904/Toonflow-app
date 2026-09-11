# Agent云供应商

`agentsYun.ts`（供应商 ID：`agentsYun`）只接入本轮已核对的 3 个图像模型和 4 个 Seedance 视频模型。Wan、MiniMax、PixVerse 及其他 Agent云目录条目不在本文件的能力声明内。

图像模型：

- `Seedream-4.5`：2K / 4K。
- `Doubao-Seedream-4.5`：2K / 4K。
- `Doubao-Seedream-5.0-Lite`：2K / 3K / 4K，并可选择 `png` / `jpeg` 输出。

图像请求会按项目画幅把档位转换为文档允许的 `宽x高`，例如 2K 的 9:16 为 `1440x2560`，3K/4K 按同一比例放大。不会把固定 `2K` 直接发成默认方图。

视频模型：

- `Doubao-Seedance-2.0`：4–15 秒，480p / 720p / 1080p / 4k。
- `Doubao-Seedance-2.0-mini`：4–15 秒，480p / 720p。
- `Doubao-Seedance-2.0-fast`：4–15 秒，480p / 720p。
- `Doubao-Seedance-2.5`：4–30 秒，480p / 720p / 1080p。

Agent云成员密钥页面已确认 API 端点为 `https://api.agentsyun.com/relay/v1`。供应商默认保存完整地址 `https://api.agentsyun.com/relay/v1`，也接受用户粘贴 origin 地址或带尾斜杠的完整 `/relay/v1/` 地址，并只拼接一次协议前缀。请求路径为：

```text
POST {API_ORIGIN}/relay/v1/image/stellar/generations
POST {API_ORIGIN}/relay/v1/video/seedance2/generations
GET  {API_ORIGIN}/relay/v1/video/seedance2/tasks/{task_id}
```

`API_ORIGIN` 是从配置中提取的 HTTPS 域名部分。

所有请求使用 `Authorization: Bearer <API Key>`。代码不包含密钥，也不会在错误中回显密钥。

图像请求会按项目画幅把档位转换为文档允许的 `宽x高`：2K 的 1:1、9:16、16:9、3:4、4:3、2:3、3:2、21:9 分别使用标准尺寸表，3K 和 4K 按 1.5 倍与 2 倍放大。未知比例拒绝，不把固定 `2K` 直接发送成默认方图。

## 图像

图像请求是同步协议，不创建任务、不构造虚假 task ID，也不使用进程内轮询缓存。供应商导出 `synchronousImageRequestVersion=1` 和 `synchronousImageRequest`，宿主可以把同步调用包在自己的持久化任务中。

请求默认使用：

```json
{
  "response_format": "url",
  "sequential_image_generation": "disabled",
  "watermark": false
}
```

`image` 支持单个公网 URL、合法图片 Data URL 或数组；最多 14 张参考图。组图相关的输出图数仍须由宿主保证与参考图合计不超过 15。同步单图响应的 `data[]` 必须恰好有一项，不能静默丢弃多张结果。每项严格验证 `url` 或 `b64_json`；成功响应缺图、URL 无效、base64 无效、超过 40MB，或 MIME 与 PNG/JPEG 文件 magic 不一致均失败。文档示例中的 `optimize_prompt_options` 不会转发。

`imageRequest` 仅作为旧式兼容入口，返回 URL 或 Data URL；新宿主应优先使用同步结构化结果。

图像明确的 HTTP 400/401/402/403/404/405/413/415/422/429 会在错误对象上标记 `submissionOutcome="rejected"`，表示请求未创建付费生成；5xx、网络错误、超时或响应不明确不标记为已拒绝，由宿主按未知提交结果处理，不能自动重复 POST。

## Seedance 视频

视频任务通过 `submitVideoTask` / `queryVideoTask` 持久恢复。创建响应只接受非空 `task_id`；时长只接受文档列出的 4–15 秒或 4–30 秒整数，不添加未声明的 `-1`。查询将 `queued/running/processing/pending` 视为进行中，`error` 或失败/取消/过期状态映射为 failed，成功必须有 `content.video_url`，未知状态和空成功 URL 都会失败。创建结果不明确时不会自动重发 POST。

四个视频模型声明 `referenceTransport="url"`，宿主应把已经验证归属的本地素材转换为受控公网 URL。2.5 支持首帧、首尾帧和多参考；帧任务会把工作台固定比例映射为 `ratio=adaptive`。2.0 支持文生、`reference_image` 单图和文档声明的图片/视频/音频多参考。

2.5 多参考上限为图片 30、视频 10、音频 10，并允许文本加纯音频参考。2.0 系列同样按文档声明支持图片 / 视频 / 音频多参考，适配器目前采用 9 / 3 / 3 的保守参考数量上限（平台详情页未明确列出这三个数量），但音频不能作为唯一参考。视频接口的所有参考素材必须是公网 HTTP(S) URL，不接受 Data URL 或 `asset://ID`。图片、视频、音频参考均按输入顺序写入 `content[]`，类型分别为 `image_url`、`video_url`、`audio_url`。

## 验证边界

`tests/agentsYunProvider.test.ts` 使用 VM 和模拟 HTTP 响应，验证精确模型目录、图像同步返回、base64/URL 严格解析、参考和质量上限、Seedance 创建/查询路径、adaptive 映射、状态/错误处理及不重复 POST。没有调用真实 Agent云接口、没有发送真实密钥或付费请求。

接口依据：[Seedream 4.5](https://www.agentsyun.com/enterprise/api/models/54)、[Doubao Seedream 4.5](https://www.agentsyun.com/enterprise/api/models/31)、[Seedream 5.0 Lite](https://www.agentsyun.com/enterprise/api/models/50)、[Seedance 2.0](https://www.agentsyun.com/enterprise/api/models/61)、[Mini](https://www.agentsyun.com/enterprise/api/models/62)、[Fast](https://www.agentsyun.com/enterprise/api/models/63)、[Seedance 2.5](https://www.agentsyun.com/enterprise/api/models/73)。实际网关由成员密钥页面和用户配置确认。
