# Production flow security review

Date: 2026-09-09

This review covers the relational production flow, HTTP handlers, production-agent socket route, and agent tools. The tests use an isolated temporary SQLite database and the real `ensureProductionStateSchema` triggers. No external API or production database was contacted.

## Evidence completed

`tests/productionFlow.test.ts` verifies that:

- existing relational script, asset, and storyboard rows are returned when `o_agentWorkData` is absent;
- damaged JSON and forged cached storyboard/script/asset fields cannot replace relational rows;
- project and episode mismatches are rejected;
- storyboard insertion, asset links, track creation/reuse, and track duration update commit as one transaction;
- a cross-project asset aborts the transaction with no storyboard, link, or track left behind;
- an existing locked storyboard on a reused track is not rewritten;
- planning version compare-and-swap rejects a stale writer and preserves the newer document.

The provider template check also confirmed that `data/vendor/volcengine.ts` and the embedded `src/lib/vendor.json` entry are byte-for-byte equal, including the nested Seedance media-reference fix.

## Open findings

1. The corrupted cross-project sorting case was repaired: the service now rejects inconsistent storyboard.projectId before changing any index or planning document. Its rollback regression passes.

2. Agent task recovery remains unproven. The socket keeps the active `AbortController` in process memory; reconnect, process restart, and an interrupted provider task have no durable task ownership, idempotency key, or resume/reconciliation evidence.

3. The production-agent tools perform direct asset updates/deletes before socket callbacks. Asset update/delete predicates were subsequently constrained to the authenticated project and parent asset; deletion is transactional. A dedicated real-agent authorization test is still required before declaring complete agent coverage.

4. Multi-client behavior is covered for storyboard state CAS by `tests/productionState.test.ts`, but concurrent planning-document writes, concurrent add-storyboard calls, socket reconnect races, and notification delivery after commit still need integration evidence.

5. Actual local login and Socket.IO handshakes were tested after this review: cross-project connection and context escalation are rejected, and the legitimate owner context is accepted. This does not constitute a full team RBAC audit.
