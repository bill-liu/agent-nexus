# P0 Codex approval adapter contract

Design baseline: `c705282e7eb69528c0da1ac7b506ff43f0e21427`, technical design §§08, 21, 23–25 and interaction design §§11, 22–23. Evidence captured 2026-10-12 on Linux / Node 24.19.0. This document describes offline protocol tests and SQLite logic; it does not claim that a production CLI, Sandbox, macOS package, account, or model was exercised.

## Protocol evidence

The installed **codex-cli 0.159.2** generated the unmodified JSON schemas in `tests/fixtures/cli-approvals/` using:

```sh
codex --version
codex app-server generate-json-schema --out /tmp/an-approval-schema
```

Both commands exited 0. They emitted a warning that PATH aliases could not be created on the read-only filesystem. Neither command launches an app-server session or an authentication flow. `metadata.json` records the generator binary SHA-256, individual schema SHA-256 values, version, date, and source URLs. Contract tests verify every listed schema hash. Example request/event fixtures contain synthetic data and follow these schemas; they are not recordings of a live session.

Official evidence: [Codex app-server documentation](https://developers.openai.com/codex/app-server/) and [official protocol source location](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol). The source URL is mutable; the installed binary and generated file hashes pin this contract. Availability of the public `rust-v0.159.2` source tag was not established. Documentation may describe fields absent from the pinned schema: for example `availableDecisions` and experimental `additionalPermissions` are not in this binary's generated command-approval schema. P0 rejects those fields rather than silently interpreting another version.

## Durable authority and execution claims

`ApprovalService` receives an injected `node:sqlite` `DatabaseSync` and required trusted callbacks: `trustedActor`, `authorizeDecision`, and synchronous `revalidate`. Trusted Main/Core supplies the actor; `decide` rejects a renderer-supplied `actorId`. The callbacks must consult authoritative current policy and versions, including active Run/Session/Turn, candidate and context, connection and Grant status, and node generation. Only the literal boolean `true` passes; missing or asynchronous checks cannot grant authority.

Every request freezes the subject, project, Bot, Task/revision, candidate version, context digest, Run, Session, Turn, Connection/revision, Grant/revision, node/generation, exact action, canonical parameter digest, expiry, and optional native RPC ID. JSON canonicalization sorts object keys, preserves array order, rejects non-JSON numbers/values, cycles, opaque objects, hidden properties, and accessors. The immutable request hash includes all request content; a SQLite trigger prohibits updates to that content. Native IDs are deduplicated by Run + Session + typed RPC ID; numeric `7` and string `"7"` differ. A reused native ID with changed content fails with `REQUEST_CONFLICT`.

`decide({id, expectedRequestHash, decision})` is a compare-and-set transition under `BEGIN IMMEDIATE`; a competing window receives `DECISION_CONFLICT`. An approved decision does not itself authorize execution. The trusted execution adapter must call `consume({id, expectedRequestHash, binding, action, parameters, claimId, receipt?})` at its execution boundary. Consumption checks the exact frozen binding and parameters, current expiry/policy, and durable cancellation/revocation tombstones in the same short SQLite transaction as the single-use claim and optional response receipt. A second claim receives `ALREADY_CONSUMED`.

`cancel`, `cancelRun`, `cancelTurn`, and `revokeGrant` leave durable invalidations. Turn invalidation applies to the exact Run/Session/Turn; another Turn does not inherit it. Grant revocation also blocks a new Bot/Run from using that Grant. `expire()` changes expired pending/approved requests to `CANCELLED`; expiry is independently checked even without running the sweep. Consumed records are retained as historical claims, and cancellation/resolution tombstones block further receipt replay. Cancellation does not imply that an already executed external effect was undone.

## Native mapping

Construct `CodexApprovalAdapter(service, {runtimeVersion: "0.159.2"})` only after trusted runtime preflight establishes that exact version. Missing or other versions receive `UNSUPPORTED_RUNTIME_VERSION`; compatible-looking JSON alone does not establish runtime compatibility. P0 tests supply the version as fixture evidence and do not run actual preflight.

| Native operation | P0 behavior and exact evidence |
| --- | --- |
| `item/commandExecution/requestApproval` | Accepts only kind `command` (or the pinned default when omitted), a complete exact command string and absolute cwd, supported display fields, and no unsupported environment or permission amendment. Native `threadId` / `turnId` must match the trusted driver mapping. The entire original request is included in the parameter digest; `commandActions` are display hints, never authority. Each approval covers one exact command invocation, including all bytes of a compound command. It does not separately mediate its subprocesses or internal effects. |
| `item/fileChange/requestApproval` | Requires matching `item/started` evidence containing an `inProgress` `fileChange` item, exact item/thread/turn IDs and proposed `changes` (`path`, `kind`, `diff`). The request itself has no diff. Exact changes and the original event are hashed. A changed patch fails closed. Non-null `grantRoot` is rejected because it asks for session-wide writes. |
| `networkApprovalContext` on command approval | Returns `{decision:"decline"}` with `NETWORK_NOT_SINGLE_ACTION`. The schema exposes host/protocol. Official docs state that a single approval can unblock multiple queued requests by destination, so it cannot satisfy the AN one-action claim. P0 never treats `command` as a complete network request preview. |
| `item/permissions/requestApproval` | Returns `{permissions:{}, scope:"turn"}` and `PERMISSION_GRANT_NOT_SINGLE_ACTION`. The schema allows `turn` or `session` scope; neither is a one-action permission grant. No filesystem/network permission is added. |
| `writeStdin`, exec-policy/network-policy amendments, unknown native methods or fields | Blocked. P0 does not infer hidden terminal input, execute a proposed policy amendment, or narrow unknown protocol fields away. |

`respond` accepts only `accept`, `decline`, or `cancel`. `acceptForSession`, `acceptWithExecpolicyAmendment`, and `applyNetworkPolicyAmendment` are rejected, including when an AN request was approved. `accept` requires an approved record and atomically stores the exact original-ID RPC response with its consume claim. Decline/cancel require the durable denied decision. `replay` retrieves that same stored receipt, verifies its immutable request and current live binding, and never consumes or starts execution again. This is a **transport receipt retry**, not permission to repeat the operation. `serverRequest/resolved` is checked against the persisted native thread/turn and binding before it invalidates the request. Interrupted Turns and expiry cleanup invalidate pending requests as well.

## Hard policy and mediation limitations

`evaluateRuntimePolicy` requires the exact action digest in all five trusted policy layers (user, project, Bot, Task, node). Discussion allows only explicit `resource.read` actions; generic shell commands cannot acquire read-only status from their names or parsed display hints. Approvals do not expand any hard policy layer. The evaluator is a policy gate, not an operating-system sandbox or a complete path/network policy engine.

The P0 adapter does not launch a real runtime or provide universal mediation. Native approvals depend on the CLI's effective approval settings; ordinary reads, already permitted writes, processes, plugins, MCP calls, network traffic, credentials, and direct CLI internal operations can occur without these callbacks. Accepting one command cannot enforce bounds on all effects of that command. A SQLite claim also cannot atomically include a remote OS effect or delivery of an RPC response: a crash after claim but before delivery leaves delivery uncertain. Retry uses the receipt only for a proven original still-pending request; a newly restarted native process must not receive an old receipt as a new operation. Resolved/expired/interrupted requests reject retries; the actual driver must also verify its live transport/process mapping and forbid native-ID reuse on a new process under an old Run/Session.

**P1 remains blocked** until a real Sandbox/Runner enforces filesystem paths, network destinations, process and resource limits, credential boundaries, lease/fencing generations, native pending-request lifecycle and transport retries, and current authority at each external effect. These fixture tests do not prove that any CLI internal operation is mediated or that a real model/account is usable. Claude/Cursor approval contracts are unsupported here.

## Validation scope

`npm test -- tests/contract/approvals.test.ts tests/contract/cli-approvals.test.ts` exercises durable records and competing SQLite connections, all 16 binding fields, canonicalization, changed actions/parameters, actor identity, expiry, single use, scope tombstones, policy revalidation, protocol mapping, unsupported grants, immutable schema hashes, file-event joins, safe receipt replay, native resolution and late-turn denial. These 60 tests passed locally; repository-wide evidence and remaining platform gates are recorded in [the P0 report](p0-report.md).
