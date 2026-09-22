# ADR-001 — Feedback-loop contract between the hub and every spoke

Status: ACCEPTED 2026-09-21.

## Context

A spoke is a deployed lane: this games repo first, other small products later. Nothing flowed back from a deployed spoke. Every piece below names the manual step it removes, and the same event shape must serve every future spoke without redesign.

## Decisions

| # | Decision | Alternatives rejected | Why |
|---|---|---|---|
| D1 | Events live in one ledger on the hub, in one table; ranking is views over it. | Per-spoke stores; analytics SaaS | Joins with the rest of the hub come free; SaaS = account + dependency + no raw rows. |
| D2 | The hub pulls; a spoke never pushes into the ledger. v0 = JSONL exports dropped into the hub's import folder; later a pull from a tiny ingest endpoint. | Spoke POSTs to the hub; chat webhooks in client JS; issues as an event sink | The hub is not reachable from the internet; a public webhook URL in client code is spam. |
| D3 | v0 ingest = drop folder. A serverless endpoint is deferred until the first external player. | Spreadsheet endpoints; hosted databases | Zero accounts proves the loop first. |
| D4 | Ranking and verdicts are SQL views; proposals only phrase them, and every number in a proposal must exist in the ranking or the proposal is dropped. | Free-form ranking by an agent | Agents invent numbers. |
| D5 | Flags are client-side buckets in the deployed `spoke.json`; a canary is compared with its control **inside the same window**, never before/after. | Flag service; server split; before/after | Static hosting; a hash bucket is three lines and reproducible in SQL; before/after confounds with time, version and audience. |
| D6 | The hub applies promote/revert through one script that writes only `spoke.json` and `KILLED.md`; acceptance of this ADR is the standing approval for exactly those commits. Everything else stays owner-approved. | An approval per promote/revert | Revert is a safety action; the blast radius is one config value. |
| D7 | `user_hash` = first 16 hex of sha256(a random UUID kept in localStorage). No IP, UA or fingerprint anywhere. **A cleared browser is a new user**; retention figures are floors. | Fingerprinting; cookies; accounts | No PII by construction. |
| D8 | The deployed `spoke.json` is the health check: 200 and `version == nearest git tag`. | Separate health file; uptime SaaS | One file fewer. |
| D9 | The client emits nine primitives only; `rage_quit` (session_end within 10 s of a level_fail with no win after), session length and every ratio are derived on the hub. | Client-side heuristics | One definition in one place, changeable without a redeploy. |
| D10 | Increments are proposed from templates over the ranking first; an agent may write proposals in the same block shape, scored separately. | An always-on agent | Not needed until there is traffic. |
| D11 | User content is JSON under one schema; the engine is tagged code; share = URL fragment. | Server-side content store; accounts | No accounts, no moderation surface, no storage. |
| D12 | `main` is not branch-protected: the gate is CI (tests + `version == tag`) and the two-file script. | Protect main + PR flow | It would add a click per canary decision. |

## Amendments accepted with the plan

1. Canary vs control on the proving metric within the same window. No before/after anywhere.
2. Decide at ≥ 30 sessions per arm; extend at most 3 windows, then the owner decides.
3. `user_hash` from a random UUID in localStorage; a cleared browser is a new user.
4. `rage_quit` derived on the hub (N = 10 s); the client emits primitives only.
5. A level ranks only with ≥ 10 sessions reaching it; otherwise it is reported as insufficient and never proposed on.
6. Proposals are skipped while the owner's queue is full; re-raised once after 7 days; after 14 days only the report is kept.
7. The hub commits `spoke.json` (and `KILLED.md`) through one script; `main` unprotected (D12).
8. CI asserts `spoke.json.version == git tag` (`tools/check_manifest.py`).
9. Route A (2026-09-22, issue #3): the deferral in D3 is lifted for the first external player. D2 still holds — the hub pulls: a serverless mailbox at the edge (a Worker with a small database) receives batches from the client, and the hub's nightly pull writes the same JSONL the drop folder takes, so both routes feed one table through one validator and one fingerprint. The edge gate, before any write and in this order: payload cap (32 KB, 50 events per POST); per-IP rate limit (60 requests/min); per-event schema validation (the nine primitives only, `rage_quit` refused by name); per-`user_hash` rate limit (30 requests/min); a daily circuit breaker (20 000 accepted events, then 503 with Retry-After until 00:00 UTC); a per-session cap (500 events). Every rejection is counted per reason per day, never per user. CORS is a courtesy to browsers, not a control: any client can POST, which is why the gate exists. The edge sees connection IPs; the mailbox stores none. The mailbox's code and configuration live with the hub, not in this repo; a game carries only its endpoint URL in `spoke.json` (`telemetry.endpoint`, `https://<host>/v1/events`), and the client keeps every event in localStorage until the endpoint acknowledges it, so Export (Route B) still works and a beacon that lands twice collapses on the fingerprint.

Rollback trigger: `report` events ≥ 3 per 100 sessions per version per window raises an owner decision; never automatic.

## The event

```
{spoke, version, user_hash, event, value, ctx, ts}
event ∈ session_start | session_end | level_fail | level_win | thumbs | report | purchase | ugc_publish | ugc_play
value: session_end = seconds; level_* = attempt number; thumbs = +1 / -1; purchase = USD; ugc_publish = bytes
ctx (JSON ≤ 1 KB): s = session id, level, f = active flags, ugc_id, reason
```

## Manual steps removed

| Addition | Manual step it removes |
|---|---|
| events + import | reading playtest notes, copying numbers |
| the pain ranking | deciding "what hurts" from memory |
| proposals → issues | writing issues by hand |
| canary verdict + flag commit | watching two cohorts for three days and editing a config |
| proposal hit rate | noticing the proposer is guessing |
| deployed `spoke.json` as health | opening the game to see if the deploy landed |
