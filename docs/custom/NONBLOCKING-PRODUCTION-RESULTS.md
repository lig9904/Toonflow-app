# Production without human handoffs — 1.1.8-yd.4.6

Production no longer enters a mandatory human-response or image-selection workflow. Valid generated outputs continue to be applied automatically. Missing inputs, failed targets, changed/deleted targets and uncertain provider receipts are recorded as notices or partial outcomes, while independent executable stages continue. A request with no executable step ends with a clear error. Explicit pause/cancel controls, generation authorizations, entity versions and locks remain enforced.

Saved images that cannot be applied are still completed generation results, not reasons to keep the controller waiting. Their successful step is checkpointed as complete. A task containing only retained-image notices is completed with notes; genuinely incomplete items are shown as a partial ending. No provider submission is repeated automatically.

Image result cards preserve the exact job ID, target ID and saved media path. In production, “查看生成图” opens that specific image and focuses the canvas instead of navigating to the top-level asset library. This also works after the original asset/candidate row has been removed: the durable image binding supplies media ownership, and the normal authenticated OSS handler protects access. The UI does not resurrect deleted assets or overwrite later human edits.

The production planner is told to render existing derived assets directly. If a model nevertheless proposes an id-less new asset with an existing, unique name under the same parent, the executor reuses that entity without overwriting its description. Ambiguous duplicates and stale IDs remain errors. This avoids unnecessary duplicate records and image calls.

On startup, legacy production waits are finalized without replaying work. Saved output is retained, empty tasks are identified as not executed, and the previous question/data remain in the result for audit. Script-agent waits and explicitly paused runs are unaffected. The normal deployment database backup precedes this conversion.

Validation: 275 backend tests passed, zero failed/skipped; frontend type/build and contract checks passed. The compiled-app browser test submits one simulated image job, removes its target while it is pending, confirms that the task ends without a human gate, and opens the exact retained image from the card while staying on the canvas. Anonymous access is denied and provider submission count remains one. No paid generation was run during this fix.
