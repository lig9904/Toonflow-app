# Builtin Agent implementation tracker

Target release: `Toonflow 1.1.8-yd.4.2`.

Scope: the approved Web + builtin Agent + human collaboration work. It does not add an external Agent product or server-side final-film rendering.

This tracker describes the release source, local validation and the first bounded production checks. **`LOCAL VERIFIED` is not production acceptance and is not proof that a real model provider generated media.** A production row is advanced only by the specific evidence named below.

## Evidence checkpoint

| Evidence | Result | Boundary |
|---|---|---|
| `../../../.local/builtin-full-tests.log` | 250 passed; 0 failed, cancelled, skipped or todo | Local PostgreSQL/service/route/provider-contract tests; upstream media and text providers are simulated |
| `../../../.local/builtin-browser-restart-result.json` | Actual Chrome + compiled app + isolated PostgreSQL; HttpOnly cookie login; browser close/reopen; application SIGKILL/restart; durable run succeeded; one durable image create and one allowance; image-flow round trip; pure import; durable novel events and audio matching; 0 paid calls | Local fixture only; it does not prove production deployment, real-provider output or creative quality |
| `../../../.local/five-browser-collab-result.json` | Five browser contexts with five distinct HttpOnly sessions; shared workspace; concurrent same-script writes returned 200/409; viewer and revoked-member writes returned 403; other member stayed active; task totals matched; 0 paid calls | Local collaboration fixture only |
| Current source and contracts | Durable runtime, shared-team authorization, project/content/assets/production workspaces, image/video job recovery, task overview, image flow, novel-event and role-audio paths are wired; Seedance 2.5 exposes the six approved Standard variants | App source checkpoint `44a95d5`; package checksum and full production acceptance remain separate |
| Web `custom/main` | `da697b1` | Frontend source and deployed revision checkpoint |
| Production release | `20260910-021452-yd42`; app `44a95d5`; Web `da697b1`; service, PostgreSQL and ingress active; six Seedance 2.5 models listed; provider credential/custom-model/enabled-state fingerprints unchanged | Bounded deployment evidence, not full business acceptance |
| Production smoke | Real ScriptAgent: 2 calls, 5 steps, one saved episode (ID 2). Real ProductionAgent: 1 call, 5 steps, 1 video allowance and one completed video job. Actual Chrome Chat/artifact, media Range/thumbnail and HTTPS/NAS byte checks pass | Initial short-budget planning failure was fixed in yd.4.1. Only domestic Standard T2V was paid-tested; broader modes retain local contract evidence |

Status meanings:

- `LOCAL VERIFIED`: the stated behavior has current automated and/or real-browser local evidence.
- `LOCAL PARTIAL`: important pieces pass locally, but part of the stated acceptance scenario has not been exercised.
- `BOUNDARY VERIFIED`: the intended product boundary is explicit; a separate compatibility check remains.
- Every row marked `PROD PENDING` or `LIVE PENDING` remains open even if its local status is verified.

## Batch status

| Batch | Local status | Evidence and remaining boundary |
|---|---|---|
| B1 Runtime + ScriptAgent | LOCAL VERIFIED | Durable run/step/event, limits, idempotency, waiting-human continuation, takeover fencing, server-owned structured script saves, Socket cookie/origin checks, browser close/reopen and process restart are covered locally |
| B2 Project/content/episodes | LOCAL VERIFIED | Transactional project and episode IDs, CAS, pure novel import, durable event extraction, delete guards and stale-result rejection are covered locally |
| B3 Complete assets | LOCAL VERIFIED | Asset/audio CRUD, upload validation, candidates, derived assets, bindings, extraction, deletion guards and durable audio matching are covered locally; real uploaded audio/video playback remains a production/NAS check |
| B4 ProductionAgent/media | LOCAL VERIFIED | Planning/storyboards, four durable image paths, image-flow ownership/CAS, ordered references, video job recovery, late-result guards and independent target concurrency are covered with simulated providers |
| B5 Human handoff + five users | LOCAL VERIFIED; TEAM PROD VERIFIED | Real local Chrome completed question/answer/continue, pause/resume and takeover/resume with saved artifacts. Separate production Chrome contexts confirmed five-session shared access, CAS and role/revocation enforcement |
| B6 Quality/release | VERIFIED FOR BOUNDED RELEASE | yd.4.1 deployed; source/package checksums, preserved config, isolated backup restoration, live script/video, private media playback and one landscape quality/usage sample are recorded in BUILTIN-RELEASE.md. Broader provider and creative combinations are not claimed |

## Acceptance audit

| ID | Requirement | Local status | Current evidence / remaining local gap | Production or live status |
|---|---|---|---|---|
| T01 | 从零新建 | LOCAL VERIFIED | API project creation returns stable IDs and is transactional/idempotent; actual browser fixture creates a project; five sessions see the shared workspace | PROD VERIFIED for API creation and saved episode; multi-user checks separately recorded under T20 |
| T02 | 模型/风格 | LOCAL VERIFIED | Enabled typed models and Web options are validated without loading secrets; unsupported combinations fail before submission | LIVE VERIFIED for catalog and domestic Standard T2V; other five new variants are contract-tested |
| T03 | 原文导入 | LOCAL VERIFIED | Pure import is idempotent, preserves serialized chapter order and makes no model call; browser fixture confirms pure import | PROD PENDING |
| T04 | 事件/改编 | LOCAL VERIFIED | Chapter IDs/versions/hashes are snapshotted; independent chapters run durably; stale results are rejected; browser fixture confirms durable events | LIVE PENDING for real-model content/output |
| T05 | 剧本分集 | LOCAL VERIFIED | Stable script IDs, workspace CAS, atomic content/binding saves, explicit clear semantics and cross-project rejection pass | PROD PARTIAL: real DeepSeek run saved one script (ID 2); concurrency/edit/delete paths not production-checked |
| T06 | 素材提取 | LOCAL VERIFIED | A new script's actual ID feeds structured extraction; committed bindings are visible to the reviewer; project ownership is enforced | LIVE PENDING for real-model extraction quality |
| T07 | 图片上传 | LOCAL VERIFIED | Forged bytes are rejected before staging; flow upload preserves validated bytes under a stable owned key; thumbnail access works in browser fixture | PROD PENDING for configured NAS |
| T08 | 视频与音频上传 | LOCAL PARTIAL | Type, ownership and audio child-reference rules pass locally; no current evidence records real production audio/video playback and Range behavior | PROD PENDING |
| T09 | 候选和衍生 | LOCAL VERIFIED | Real versioned IDs, parent ownership, candidate ownership/history, CAS and locked-reference guards pass | PROD PENDING |
| T10 | 剧集素材 | LOCAL VERIFIED | Omitted bindings preserve, explicit empty bindings clear, foreign inputs roll back and concurrent writes have one winner | PROD PENDING |
| T11 | 分镜素材 | LOCAL VERIFIED | Ordered storyboard/asset references are loaded from the relational source; wrong project/type/missing capability fails before provider work | PROD PENDING |
| T12 | 音频绑定 | LOCAL VERIFIED | Manual bind/clear, child normalization, wrong-family rejection and durable model-matching receipt pass; browser fixture confirms durable matching | LIVE PENDING for real-model matching quality; TTS/voice cloning is not claimed |
| T13 | 导演规划 | LOCAL VERIFIED | Concurrent initial planning has one winner; save is server-owned and does not trigger unrequested media work | LIVE PENDING for real-model planning quality |
| T14 | 分镜 CRUD | LOCAL VERIFIED | Production plan creates real storyboard IDs; track create/update/delete uses idempotency and CAS; relationship and lock rules pass | PROD PENDING |
| T15 | 分镜与素材图片 | LOCAL VERIFIED | Root, derived, storyboard and image-flow paths use durable jobs, ordered references, saved task IDs and late-result protection | LIVE PENDING for real image generation and media inspection |
| T16 | 图片编辑流 | LOCAL VERIFIED | Project/episode ownership, stable upload, flow CAS, legacy-owner backfill rules and browser round trip pass | PROD PENDING for deployed Web/NAS round trip |
| T17 | 视频参考 | LOCAL VERIFIED | First/end frames and ordered image/video/audio references, mode/count/MIME limits and Seedance 2.0/2.5 boundaries pass contract tests | LIVE VERIFIED for the bounded domestic Standard T2V scenario; I2V/Multi ordering and counts are locally contract-tested |
| T18 | 视频持久化 | LOCAL VERIFIED | One-shot submit, saved upstream ID, restart query-only behavior, separate query/download retry and no uncertain resubmit pass | LIVE VERIFIED: one saved upstream task ID, one job row and one NAS result; forced restart remains covered locally |
| T19 | 定稿/审核/返工 | LOCAL VERIFIED | Same-track candidate selection, CAS, locks across direct/relationship/delete paths, review transitions and isolated-target failure pass | PROD PENDING for full user workflow |
| T20 | 五人并发编辑 | LOCAL VERIFIED | Five real browser contexts and distinct sessions share data; same-script conflict is 200/409; viewer/revoked writes are denied | PROD VERIFIED: five real contexts/distinct sessions; shared reads200, concurrent write200/409, viewer/revoked403, another editor200; temporary data removed |
| T21 | 撤销/越权 | LOCAL VERIFIED | HTTP, Socket, media/resource, task/filter and route-registry authorization checks pass; role configuration cannot enlarge limits | PROD VERIFIED for viewer/disabled-account denial, another editor continued access, anonymous API/media401; full route registry remains locally checked |
| T22 | 授权额度 | LOCAL VERIFIED | Concurrent reservations remain within limits; idempotent retries reuse receipts/jobs; query/download/select paths do not create a second upstream task | LIVE VERIFIED: duplicate start reused the run; one video allowance and one upstream job; terminal upstream video usage ¥2.691562 |
| T23 | NAS 故障/恢复 | LOCAL PARTIAL | Local tests prove an absent mount/marker does not silently fall back to application storage | PROD VERIFIED in an isolated mount namespace: missing NAS rejected, no fallback, real host mount/PID unchanged; no live network outage claimed |
| T24 | 任务与统计 | LOCAL VERIFIED | Durable sources are merged without duplicate projections; join identity/filter scope and real storyboard statistics pass; five-browser totals match | PROD VERIFIED for current task UI and saved run/media receipts; broader statistics fixtures remain local |
| T25 | 下载与预览 | LOCAL PARTIAL | Thumbnail and media ownership checks pass; download retry behavior is durable | PROD VERIFIED: new video HTTPS/NAS bytes identical, full decode, Range206, anonymous401; existing thumbnail200 |
| T26 | 成片边界 | BOUNDARY VERIFIED | Existing Web browser export remains the final-film path; no server renderer is claimed | PROD VERIFIED: real candidate selection, material-library read, loaded-card drag/drop and browser export; MP4 fully decoded. Export adds padding/silent AAC; no server renderer claimed |
| T27 | 人交给 Agent | LOCAL VERIFIED | Actual Chrome question/answer/continue, pause/resume, takeover/resume and saved Chat artifacts pass in the isolated fixture; no paid calls | PROD PENDING for a recorded full Web handoff without duplicate entry |
| T28 | Agent 交给人 | LOCAL VERIFIED | Actual Chrome question/answer/continue, pause/resume, takeover/resume and saved Chat artifacts pass in the isolated fixture; no paid calls | PROD PENDING for a recorded project-page handback showing candidates, completed work, questions and next actions together |
| T29 | 人工接手同一资源 | LOCAL VERIFIED | Takeover fences the old executor; late script/image results cannot overwrite newer human state and remain authorized unselected candidates where appropriate | PROD PENDING |
| T30 | 依赖素材被修改 | LOCAL PARTIAL | Stale versions stop affected commits and independent image targets continue despite another conflict | PROD PENDING for one end-to-end dependency-impact and scoped-rework scenario |
| T31 | 执行者断开与接任 | LOCAL VERIFIED | Two runtimes recover expired leases and fence late writers; actual compiled app survives SIGKILL/restart with no duplicate image create or allowance | PROD PENDING |
| T32 | 暂停与续做 | LOCAL VERIFIED | Actual Chrome question/answer/continue, pause/resume, takeover/resume and saved Chat artifacts pass in the isolated fixture; no paid calls | PROD PENDING for a complete browser question/reply/replan/continue sequence |
| T33 | 人机混合并行 | LOCAL VERIFIED | Independent episodes/targets proceed concurrently; same-resource CAS/locks conflict clearly; durable actor/events/receipts preserve origin | PROD PENDING |
| T34 | 内置运行独立于浏览器 | LOCAL VERIFIED | Actual Chrome closes during delayed model work, reopens without resubmit, and reads the persisted successful run | PROD VERIFIED for a server-owned run and persisted Chat readback; literal close/reopen during execution is covered locally |
| T35 | 结构化保存与旧链兼容 | LOCAL VERIFIED | Script/planning/storyboard artifacts are server-owned, transactional, versioned and saved without a browser/XML callback | PROD VERIFIED for one real saved episode and one production artifact; legacy media reads also passed |
| T36 | 调用预算与角色质量 | LOCAL PARTIAL | Model/tool/output/retry ceilings, explicit zero values, call counts and 0-paid-call fixtures are verified | LIVE VERIFIED for a bounded landscape sample, exact video usage and measured output; no claim of multi-character/multi-shot quality benchmark |

## Coverage beyond the bounded release

The release record contains the completed deployment and real-provider smoke. Local tests cover fault/concurrency paths that should not be deliberately repeated as disruptive failures against active user work. The remaining broader coverage is: all provider/format combinations, a multi-character and multi-shot creative benchmark, and a genuine NAS/network outage drill. None is inferred from the successful single landscape clip. Browser handoff/export and separate production team-role evidence are appended when their bounded checks complete.

## Final deployment checkpoint

The preceding rows retain their audit boundary. The latest verified release is yd.4.2, `20260910-021452-yd42`, app `44a95d5`, Web `da697b1`. See `BUILTIN-RELEASE.md` for exact artifact checksums and live evidence. The planning failure has been corrected and the same short-budget ProductionAgent scenario now completes: 1 model call, 5 steps, 1 video allowance, one upstream job and one NAS result. The actual 4-second domestic Standard T2V output decodes and plays at 854×480 with audio off; HTTPS bytes match NAS and the upstream charge is ¥2.691562. Existing media Range/thumbnail, saved Chat/artifact navigation, backup restoration in an isolated database, and the NAS guard in an isolated mount namespace also passed. These checks do not claim separate paid output acceptance for the other five variants.

Final source preferences were also integrated: UI thinkLevel is validated, persisted in server-owned run intent and reused on continuation, while the previous field-free API shape keeps its idempotency identity. Final full regression:250/250, compiled-app Chrome restart fixture passed again. The final deployment reused the same existing video run/job/task ID without another generation.
