# Upstream 同步约定

上游：https://github.com/HBAI-Ltd/Toonflow-app

Fork：https://github.com/lig9904/Toonflow-app

2026-09-09 拉取基线：

- `upstream/master`: `e03cf590eb0cab63534a4040db9acb4ec95b42a6`
- `upstream/develop`: `10d98520fc0f68b9846e5a056e1f52820b74e93a`
- 本地工作分支：`custom/main`，起点为 `origin/master`。
- 本地稳定基线：`upstream-sync/master`；官方 master/develop/solo 历史保留在 upstream 远端跟踪分支。
- 初始 Fork 只复制了 master；定制源码在 custom/main 分支维护，master 保留上游基线。

同步先 `git fetch upstream`，审查 master 的具体变化，再集成到 custom/main。develop 修复须逐项核对、移植并复测，不整体合并分叉分支。保留 LICENSE 与 NOTICES.txt。

定制发行版从 `1.1.8-yd.1` 起使用独立版本标识。运行中的程序由管理员部署更新，不读取原版更新清单，不接受浏览器提交的更新包 URL，也不直接覆盖数据目录。上游更新须经过 Fork 中的审查、测试和重新构建，再以独立发行目录部署；当前尚未建立 GitHub 自动发布流水线，源码发布分支为 custom/main。

媒体修复来源：后端 PR #245（`ee7eccb1aed069ef9b6eaf6286d28366568a4791`，merge `d92edb5f4112153a2375d2d4c5a9714ff30bc51d`），前端 `cff23f72fccf592e166797417efee1414a3afca5`。保留来源和本地修正，后续上游包含这些改动时优先消除重复补丁。
