# Builtin production output fix — 1.1.8-yd.4.3

Production runs could repeatedly ask for asset selection, reject synonymous phase names, or fail with the generic `No output generated` message before saving their work. Larger plans also encountered the inherited PostgreSQL `varchar(255)` limit on the serialized workspace column.

This release makes these changes:

- The production planner uses the server's actual phase/ID/authorization contract instead of the old browser-side tool-dispatch instructions. Creative stages retain their professional reference guidance under an explicit structured-output contract.
- `planning` / `directorPlan` and `storyboard` / `storyboardTable` normalize to one execution each. Unknown phases and foreign resource IDs remain invalid.
- The planner's free-form summary is no longer displayed as a claim that work was saved. The server announces planned actions and emits artifacts only after actual commits.
- Missing derived-asset targets produce a concrete question with available names/IDs. Successful derived changes now emit an artifact event so the current flow refreshes.
- Director planning writes only the director plan and preserves an existing shot table. Storyboard rows and a readable table are saved in one transaction. The long storyboard stage can use tokens left over from earlier model calls without enlarging the authorized run limit.
- The SDK finish reason and provider-reported usage are read before accessing structured output. Length limits, filtering, incomplete completion and invalid formats receive distinct messages. Failed structured calls retain reported token usage and safe diagnostic counters; raw response text, reasoning text and credentials are not stored in diagnostics. No automatic model retry is introduced.
- New databases use `text` for `o_agentWorkData.data`; existing varchar columns are widened to text without rebuilding the table or changing its contents.

Validation: backend TypeScript check; 258 tests passed, zero failed/skipped; real SDK mock responses reproduce the former throwing getter and validate error categorization, usage and data redaction. A PostgreSQL regression creates 18 distinct shots totaling 60 seconds, preserves valid IDs, writes their table atomically, executes aliases only once and demonstrates reuse of remaining output budget. Another test migrates an existing varchar workspace while preserving its previous data and then saves a long plan. The compiled application/Chrome close-and-restart integration also passes with simulated providers.

Historical runs did not retain the provider finish reason, so their generic output errors cannot be retrospectively classified with certainty. In particular, a token limit can reproduce the old message but is not asserted as the reason for every historical failure. No paid provider request or failed user task was replayed during this fix. Existing failed records remain historical records; a new task uses the corrected contract.
