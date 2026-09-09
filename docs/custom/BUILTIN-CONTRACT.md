# Builtin Agent implementation contract

This is the shared implementation contract for the Web/builtin-agent work. Existing creative entities, HTTP routes, PostgreSQL storage and NAS remain authoritative. No external agent product integration is in scope.

## Ownership in the initial parallel implementation

- Primary: this contract and `src/services/builtinAgent/contracts.ts`, app/db bootstrap, HTTP run routes, ScriptAgent structured business persistence, model adapter, final integration.
- Runtime worker: only `src/services/builtinAgentRuntime/**` and its own tests/helpers. Import shared types from `../builtinAgent/contracts`.
- Team security: only `src/services/team/**`, `src/routes/team/**`, and its own tests/helpers. Export integration middleware/functions; do not edit app/db/bootstrap or existing routes concurrently.
- Web: `src/types/builtinAgent.ts`, `src/stores/builtinAgent.ts`, new builtin run UI components, ScriptAgent/ProductionAgent stores and UI; coordinate login/session migration before touching it. No backend edits.

## Browser run API (root implements; paths below omit /api)

All responses use the existing `{code:200,data:...}` convention. On failure use a real HTTP status and `{code,message}`. Server obtains `requestedBy` from the authenticated user, never from the body.

- `POST /builtinAgent/start`: `{agentType,projectId,scriptId?,prompt,idempotencyKey,limits?,thinkLevel?}` → `{run: BuiltinRunView,reused:boolean}`. Full shared types are in `contracts.ts`. Optional `thinkLevel` is an integer 0–3; only an explicitly supplied value is copied into server-owned run intent. It is part of idempotency identity and remains fixed for continuation. Omitted values keep the older request identity and resolve to level 0. Creative roles honor the level; short decision roles keep extended thinking off. Clients cannot supply arbitrary intent. Generation allowances default to zero; explicit user authorizations are included in the run limits and server checks.
- `POST /builtinAgent/list`: `{projectId,scriptId?,limit?}` → `{runs:BuiltinRunView[]}`.
- `POST /builtinAgent/get`: `{runId,afterSequence?:number}` → `{run,events:BuiltinRunEvent[],nextSequence:number}`. Polling is read-only and never starts work.
- `POST /builtinAgent/control`: `{runId,expectedVersion,action:"pause"|"resume"|"cancel"|"takeover",reason?,answer?}` → `{run}`. `answer` is a human response to waiting_human, passed to runtime as the control reason. Stale version returns 409; unauthorized access 403. `takeover` pauses and invalidates creative input revision; it never queues automatic work. `BuiltinRunView.inputRevision` and `continuation` carry resumed creative context. Pure creative step keys include inputRevision; durable media receipts do not get blindly recreated.

Event types include `run.created`, `run.status`, `step.started`, `step.completed`, `message.delta` (data `{text}`), `message.completed` (`{text}`), `artifact.saved` (`{kind,ids?,version?}`), and `run.error`. Event sequence is monotonically increasing per run. Browser deduplicates, appends messages as text, and refreshes authoritative creative data after artifact events. It must not save XML-tag text as business data.

The first browser implementation may poll `get` while visible. Closing a page never sends cancel. HTTP polling must pause/restart without creating another run. Socket replay will be integrated with the same event contract.

## Runtime contract

Export `ensureBuiltinAgentRuntimeSchema(db)`, `BuiltinAgentRuntime` and `BuiltinRuntimeError` from `src/services/builtinAgentRuntime/index.ts`.

Constructor options: `{db, execute(context):Promise<unknown>, authorize(run):Promise<void>, now?,pollMs?,leaseMs?,workerId?}`.

Public methods: `create(input:CreateBuiltinRun) -> {run,reused}`, `get(runId) -> run`, `list({projectId,scriptId?,limit?}) -> runs`, `events(runId,afterSequence?,limit?) -> events`, `control(runId,expectedVersion,action,reason?,actorId?) -> run`, `start()`, `stop():Promise<void>`, `runOnce():Promise<boolean>`.

Execution context: `run`, `signal`, `emit(type,data)`, `assertActive()`, `step(key,input,perform,options?:{modelCall?:boolean,sideEffect?:boolean})`, `commit(key,input,perform:(trx)=>Promise<unknown>)`. Step results persist and replay only when input hash matches. `commit` atomically saves business effects, step completion and critical event. All mutations are fenced by run lease/epoch and current permission. Model/NAS/network calls remain outside DB transactions. Per-run counters enforce limits. Pause/takeover invalidate the old executor and reject late business writes.

After a crash, completed steps replay saved results. An interrupted external side effect without a persisted receipt becomes `reconciliation_required`, not an automatic second submission. Resuming paused work rechecks permissions and versions. Production media submission will reference existing durable job IDs.

## Team contract

Single shared team with roles `admin|editor|viewer`; existing project IDs and owner fields are retained. Implement server-side role/project checks, enabled status and revocable sessions. Export `ensureTeamSchema(db)`, `getTeamUser(db,userId)`, `requireProjectAccess(db,userId,projectId,action:"read"|"edit"|"review"|"delete")`, `requireTeamRole(db,userId,roles)`, plus session/auth and route-authorization helpers. API middleware receives DB rather than importing the production singleton.

For old isolated fixtures with no team schema, existing owner-only behavior may remain as a test/backward compatibility path. Real application bootstrap must initialize team schema before serving; migration failure must fail startup rather than silently bypass checks.

Team routes: `POST /team/me` → `{user:{id,name,role,enabled,version},capabilities:{manageMembers,edit,review}}`; `POST /team/listUsers` → `{users}`; `POST /team/createUser` with `{name,password,role}` → `{user}`; `POST /team/updateUser` with `{id,expectedVersion,name?,role?,enabled?}` → `{user}`. Admin only for member writes/list. Never return password hashes or session secrets. Preserve at least one enabled admin.

## Verification boundaries

Use isolated PostgreSQL tests for new runtime/security behavior. Existing SQLite fixtures are test-only legacy compatibility and do not change the PostgreSQL runtime requirement. Do not call paid models or production APIs from tests. Do not edit generated `data/serve/app.js`, install global tools, change global Git identity, or commit/push independently.
