# 本轮协作改造

网页与内部 ProductionAgent 通过 productionFlow 读取关系表。缓存 o_agentWorkData 只保存导演计划、分镜表文字与 planningVersion；剧本、资产、分镜、关联和轨道仍以原表为准。缺失或损坏缓存不会隐藏已有分镜。

productionState 为分镜维护 ext_entity_state。文字修改、图片替换、删除和审核/锁接口要求 expectedVersion。事务先校验 o_storyboard→o_script 的项目归属，再比较版本及锁，最后落库。旧入口的原表及素材关联变更也由 SQLite 触发器拒绝锁定修改、递增版本，并将已审核内容退回草稿。事务内部保留标记只用来避免服务写入与触发器重复加版本，不返回浏览器。

人工身份来自已验证 JWT 的用户 ID，并检查项目 owner。HTTP 请求中的 actor 字段不被接受。审核/锁为 human 操作，解锁须锁持有人。生成中的分镜不能锁定。owner 检查仅是当前单用户到协作纵切的保护，尚非完整团队 RBAC。

ProductionAgent 的 get_flowData 和 add_flowData_storyboard 已从浏览器回调改成服务端读取/事务新增。成功提交后广播 productionStateChanged；Socket 登录、项目/剧集上下文和通知接收范围均校验。图片/资产生成等其余 Agent 工具仍有浏览器回调，暂不能宣布已可完整无人值守。

规划保存以 expectedPlanningVersion 作前置条件，并只在验证完整分镜集合及各自版本后改变排序。前端串行提交快照，冲突保留草稿，显式重新载入后再合并。

继续沿用 volcengine Provider 的可配置 baseUrl、API Key 与模型名，不新增中转 Provider。本轮修复 image/video/audio 类型、独立引用编号和嵌套参考声明被忽略的问题。模型列表是上游默认示例；真实中转支持情况必须按对方文档核对。
