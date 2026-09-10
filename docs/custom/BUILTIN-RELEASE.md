# Toonflow 1.1.8-yd.4.2

Subsequent production-output and workspace-storage fixes are recorded in [1.1.8-yd.4.3](STRUCTURED-OUTPUT-FIX.md).

Independent per-request production output and checkpoint recovery are recorded in [1.1.8-yd.4.4](INDEPENDENT-PRODUCTION-OUTPUT.md).

Live canvas previews, capability-driven quality choices, autosave and image-preparation recovery are recorded in [1.1.8-yd.4.5](CANVAS-LIVE-UPDATE-FIX.md).

The shared-team builtin Agent release is deployed. It includes the six documented Seedance 2.5 Standard models in the existing relay, and a live ScriptAgent → ProductionAgent → video job completed successfully.

## Included behavior

- Shared admin/editor/viewer accounts and revocable HttpOnly sessions for HTTP, Socket and private media access.
- PostgreSQL-backed runs, steps, limits, events and continuation. Closing the browser does not own or terminate the worker.
- Versioned project/content/script, assets, audio families, role matching, novel events, director planning, storyboards and image-edit graphs; structured server saves and idempotent receipts.
- Durable image/video jobs with saved upstream IDs, query/download recovery, candidate preservation and protection against late results overwriting human edits.
- Original Chat and task-center views expose saved artifacts, questions, pause, takeover and continuation. The existing thinking-strength control now travels with the run and persists across continuation: creative stages honor the selected level; short decision stages keep thinking off.
- Six Seedance 2.5 models: domestic/international T2V, I2V and Multi. Fixed durations 4–30 seconds and documented mode/reference limits are enforced. See [SEEDANCE25-ADAPTER.md](SEEDANCE25-ADAPTER.md).

## Source and release

- App source: `44a95d5b71dd1a8118110e0091cf9f41aaf5530c`.
- Web source: `da697b1a142b29206f1beafbc4acbcce86e69e18`.
- Both are pushed to the owner's `custom/main` branches.
- Immutable release: `20260910-021452-yd42`.
- Package SHA-256: `137352f061ac5a14637982ba56c845eef5f770cfed9329a90e13f1ef3bb35dc9`.
- Per-file hashes and source revisions are recorded in the deployed `release-manifest.json`.
- Database backup ran before switching releases. A pre-switch dump passed its checksum and was restored into an isolated PostgreSQL database, then that verification database was removed.
- Previous application releases and provider sources remain available; the installer restores both if release health checks fail.
- All 12 provider rows retained the same credential/custom-model/enabled-state fingerprint. Existing administrator credentials were not reset.

## Local validation

- Full suite: 250 passed, 0 failed or skipped. Backend type check and frontend production build passed.
- The decision-output fix passed 16 related tests. The subsequent thinking-preference change passed real PostgreSQL HTTP persistence/idempotency/range checks, 23 executor checks, type checks and the frontend build. The final full suite again passed all 250 tests, and the compiled-app/Chrome close-and-restart scenario was rerun successfully.
- Actual Chrome + compiled app + isolated PostgreSQL covered project creation, HttpOnly login, browser close/reopen during model work, SIGKILL/restart during an accepted image job, one upstream create/allowance, upload/thumbnail, image flow CAS, T2I/I2I pairing, pure import, durable events and voice matching.
- Five separate browser contexts with five distinct sessions covered shared data, same-script 200/409 conflicts, viewer/revoked-member 403 responses and continued access for another editor.
- A further actual Chrome fixture completed waiting-human question → typed answer → submit/continue, pause/resume, and takeover/resume through Web buttons. Two resulting runs saved their episodes and displayed artifacts; 8 mock model calls, 0 paid calls, 0 production connections, 0 browser errors. The random PostgreSQL schema was removed.
- These fixtures use simulated providers and do not establish real-model output quality.

## Production and provider validation

- App, PostgreSQL 18.6 and ingress are active; all six Seedance 2.5 models are visible.
- Five concurrent reads from one admin session completed in 45–54 ms. A separate real Chrome run then used five independent contexts and five distinct sessions: shared reads all returned 200; same-version edits to a temporary episode returned 200/409; viewer writes returned 403; a disabled editor’s old session returned 403 while another editor still read successfully. It issued no model calls. The temporary episode and four temporary accounts were removed by exact recorded IDs afterward.
- Actual Chrome using an explicitly temporary admin session displayed the saved Chat/artifact, opened the saved script, kept one composer, issued no normal bearer requests and reported no page errors. It verified the existing video Range response and thumbnail.
- Real DeepSeek ScriptAgent: 2 model calls, 5 steps, one short episode named `晨光` saved with real script ID 2 in acceptance project 2.
- The initial ProductionAgent planning attempt returned `No output generated`, before any video job or video allowance. yd.4.1 disables extended thinking for short decision calls while retaining configured creative-role behavior. With the same short output allowance, the next planning call succeeded.
- Real ProductionAgent on yd.4.1: 1 model call, 5 steps, exactly 1 video allowance; one durable video-job row reached `SUCCEEDED` with the saved upstream task ID. After the final yd.4.2 switch, the identical old start request reused that same run, job and task ID, with unchanged counters and no additional generation.
- Model: `zhenzhenRelay:seedance-2.5-standard-t2v`; requested 4 seconds, 480p, audio off. Result: 854×480, 4.041667 seconds, no audio stream, 3,156,121 bytes. Full decode and Chrome playback/seek passed.
- The HTTPS result is byte-identical to its NAS file; SHA-256 `e2eea831eb7951ec39f18441a0149c500a837dd16572782d53ad63018a01b16a`. Range returns 206; unauthenticated media access returns 401.
- Upstream terminal usage: amount `2.691562`, currency `¥`. This is the actual video charge only; it is not a quote for other model variants or a total including text calls.
- In an isolated mount namespace, removing the NAS mount made the existing guard reject the media root without creating local fallback storage. The host mount remained present and the application PID did not change. This does not claim a live NAS/network outage was induced.

## Browser editing/export

The no-mock production scenario selected the generated video through the real versioned API, read it back through the real material library API, dragged the actual loaded card into the main track, and clicked Export. Its MP4 was downloaded and independently decoded successfully: H.264 1920×1080, 2,686,534 bytes, total duration 4.352 seconds with WebAV's silent AAC track. The source is still the separate 4.041667-second, 854×480, audio-off provider result; export resampling/padding is not claimed to preserve the source duration or audio-stream structure exactly. No model call was made for export, and the original project was untouched.

The earlier automated export timeout occurred before the test had established media/sprite readiness. That failure report is retained. Waiting for the real card's metadata and the preview to be ready produced the final no-mock success.

## Sample review and boundaries

The saved script follows the requested short lake-at-sunrise scene without characters or dialogue. Three sampled video frames (0.5, 2 and 3.5 seconds) show the requested lake, warm sunrise, moving reeds and forward camera progression, with no visible people, text or logos. This is a bounded landscape sample, not a benchmark of character continuity, all art styles or multi-shot storytelling.

Only the domestic Standard T2V variant was paid-tested in this release. The other five new variants have metadata/request contract validation, not separate paid output acceptance. No new image generation was charged during this release; current image generation/recovery evidence is local plus previously generated media read compatibility.

Existing browser editing/export remains the final-film workflow; this release does not introduce server-side final-film rendering. Automatic duration `-1` is not exposed by the current duration UI. More extensive creative comparisons and every provider/format combination are outside this bounded release smoke test.

Operational evidence is retained under the workspace `.local/deploy/` and the server's private deployment backup directory. The 36-item capability/evidence inventory is in [BUILTIN-IMPLEMENTATION.md](BUILTIN-IMPLEMENTATION.md).
