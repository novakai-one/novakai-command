# NVK-KIMI-028-B3B-AUDIT — adversarial diff audit

**Range:** `2625048b..e4f7d7de` on `kimi/b3-runtime`  
**Method:** Static contract, product-source, and test inspection only. Per the brief, suites and the reported 24/24 live run were not rerun.

## Two slice-voiding laws

- **Foundation persistence law — PASS.** The audited B3b durable records use Foundation `composeHandle`, scoped kind lists, the shared engine/CAS/trace path, and Foundation receipts (`packages/agent-runtime/core/runs-store.ts:46-84`, `packages/agents/b3/core/store.ts:58+`, `packages/agent-runtime/core/runs-compose.ts:64-92`). I found no second B3b durable record store.
- **nvk-ws v1 dialect law — PASS structurally.** Agent methods stay on `{id,method,params,v:1}` and no JSON-RPC dialect was introduced (`packages/server/core/b3/client.ts:95-117`, `packages/server/core/b3/agent-methods.ts:1-80`). The `clientOpId` carried inside that valid frame is nevertheless discarded, which is a separate Severe lifecycle-contract failure below.

## Findings

1. **SEVERE — A managed Run can default itself to the fully privileged human principal by omitting either half of its credential:** both the low-level client and CLI suppress the whole identity unless both values exist, after which the host sees no claim and grants `HUMAN_SCOPES`; the claimed “half credential” test sends an empty token rather than omitting it and misses this path (`packages/server/core/b3/client.ts:51-55`; `packages/server/cli/nvk-agent.ts:60-84`; `packages/server/core/b3/host.ts:65-88`; `packages/server/tests/b3b-agent-identity.test.ts:107-115`; Pass 1 red gate 5).
2. **SEVERE — Every `b3.agent.*` mutation discards the caller's `clientOpId`:** `readParams` accepts it, `method` does not pass it to `contextFor`, and the host mints a fresh ID, so CLI retry/resume and same-ID conflict semantics cannot reach the same Foundation receipt (`packages/server/core/b3/agent-methods.ts:40-80`; `packages/server/core/b3/host.ts:93-101`; `packages/server/core/b3/client.ts:109-117`; §4.5, §17.2, Pass 1 red gate 24).
3. **SEVERE — Delegation is neither a true authority intersection nor correctly integrated:** grant issuance treats `issuerAgentRunId` as the holder, trusts caller-supplied issuer/subject/targets, and checks scope names but not whether targets lie inside the grantor's authority; child finalisation then sends two different grant requests under one receipt key and discards the second request's inevitable idempotency conflict, leaving the parent without its child-control grant (`packages/agents/b3/core/delegation.ts:34-110,148-188,202-252`; `packages/agent-runtime/core/spawn-stages.ts:249-275`; `packages/agents/b3/core/compose.ts:60-70`; §5.3, §22, Pass 1 red gate 6).
4. **SEVERE — The required two-turn skills gate can accept the prompt as its own confirmation, and its exit proof is fake-owned:** the prompt contains the exact valid marker line, the Runtime searches undifferentiated PTY output, the shared matcher accepts the last marker even when the prompt is the only marker, and the Runtime fake parses the prompt and manufactures the expected answer (`packages/agent-runtime/core/gate.ts:57-69,139-207,215-243`; `packages/agents/b3/adapters/providers/fake.ts:122-133`; `packages/agent-runtime/tests/runs-fakes.ts:39-63,105-113`; `packages/agents/b3/tests/provider-conformance.test.ts:353-363`; §6.3, §24.2, §25-B3b).
5. **SEVERE — The stage journal is not recoverable after real mid-saga failures:** spawn and continuation compensate with the stale journal value captured immediately after open, so compensation sees neither later terminal stages nor `newRunId`, then loses its CAS; its result is ignored, leaving effects live and the operation unsettled, while append-only continuation/supervision records use fresh random IDs rather than the journal effect key (`packages/agent-runtime/core/spawn.ts:49-72`; `packages/agent-runtime/core/continue.ts:70-83,243-267`; `packages/agent-runtime/core/journal.ts:176-203`; `packages/agent-runtime/core/runs-context.ts:127-152`; §13.5-6, §20, §25-B3b).
6. **SEVERE — Stop-tree's fence and resume contract are broken:** continue/adopt check a closing fence but spawn never does, and a partial stop returns `ok(tree-stop-pending)`, causing the outer command receipt to settle as succeeded and replay the pending value instead of resuming the same operation (`packages/agent-runtime/core/spawn.ts:33-75`; `packages/agent-runtime/core/continue.ts:47-51`; `packages/agent-runtime/core/adoption.ts:28-32`; `packages/agent-runtime/core/stop-tree.ts:53-92,237-266`; `packages/foundation/contract/receipts.ts:155-182,219-230`; §13.7, §24.3 cases 14-15).
7. **SEVERE — The mandatory per-stage crash/fence/race exit proof does not exist:** the crash suite injects only store-write failure into spawn, then “restarts” with the same in-memory Agents/Terminal/provider fakes; it has no continuation crash ladder, stale-epoch injection at each stage, child-spawn/tree-fence race, or partial-stop resume proof (`packages/agent-runtime/tests/failure-injection/crash-matrix.test.ts:51-79,108-187`; absence from `packages/agent-runtime/tests`; §24.3 cases 2-3 and 14-15; §25-B3b exit).
8. **SEVERE — The advertised external/public proof imports private Server implementation and privileged host state:** it imports `core/b3/host.ts` and `core/b3/client.ts`, obtains credentials through `host.runtime`, and omits most of §24.4's required attach/send/event-cursor/usage/detach surface despite claiming published contracts only (`scripts/automation-examples/b3b-three-generations.mjs:2-16,26-34,79-89,132-171`; §24.4; Pass 1 red gates 22 and 26).
9. **MEDIUM — Family-edge Run provenance is fabricated:** child creation stores a freshly minted unrelated `AgentRunId` as `createdFromRunId` instead of the authenticated parent Run, while the family unit test only echoes a hand-supplied ID and the integrated spawn test never inspects the edge (`packages/agent-runtime/core/spawn.ts:105-114`; `packages/agents/b3/core/agents.ts:71-79`; `packages/agents/b3/tests/family.test.ts:35-60`; §5.3, B3R-013).
10. **MEDIUM — The carried-forward provider-native subagent policy has no B3b implementation or acceptance proof:** B3 adapters explicitly defer observation to B3c, and no Agent Runtime path emits `agent.run.subagent-skills-evidence.failed`, moves the parent to recovery, blocks completion, or tests managed-only/advisory/mismatch cases (`packages/agents/b3/adapters/providers/claude.ts:83-89`; `codex.ts:95-100`; `kimi.ts:98-105`; absence from `packages/agent-runtime`; §6.3, §24.2, AMD-001 A-03, §25-B3b).
11. **LOW — Stop-tree confirmation expiry is decorative:** prepare returns `expiresAt`, but execution validates only a deterministic tree hash and never checks time, so an unchanged-tree token remains valid indefinitely (`packages/agent-runtime/core/stop-tree.ts:26-50,101-114`; `packages/agent-runtime/contract/runs-api.ts:74-87`).

## Mandatory questions

### Tautological or implementation-echo tests

- The “half credential” identity test supplies `runToken: ''`; it proves the host rejects two present query parameters with a bad token, not that the client refuses one missing credential field.
- The provider echo test includes a valid assistant marker after the echoed prompt; it proves “last marker wins,” not that prompt-only output cannot confirm itself. Runtime gate tests use a fake that derives the expected tokens from the submitted prompt and writes the success line itself.
- The agent wire inventory compares `WIRE_STEPS` with the method table built by the implementation and performs unique calls without a caller `clientOpId`; it cannot detect a missing contract method or broken retry/conflict behavior.
- Delegation tests exercise scope-name filtering but not target-scope intersection; the “next generation” test deliberately passes an issuer Run different from the authenticated caller and thereby ratifies the implementation's issuer/holder confusion.
- Family tests pass `creatingRunId` into Agents and assert that Agents stores it, while the Runtime integration that invents that value is not asserted.
- The crash suite's fake Terminal owns adopt-by-operation and gate-answer behavior, and the restarted composition shares those same live in-memory instances; the fake therefore owns crucial no-duplicate/recovery proof.

### §25-B3b exit-assertion matrix

| Assertion | Would a current test fail if the property broke? | Audit result |
|---|---|---|
| Role profiles and pinned launch plans | **Yes** for creation, override policy, immutable pinning, and CAS in `packages/agents/b3/tests/launch-plan.test.ts`. | Covered for the asserted basics. |
| Carried-forward two-turn gate for supervised Runs | **No**, not for prompt provenance, real-provider supervised launches, termination cleanup, or native-subagent evidence. | Exit not met; Findings 4, 5, 10. |
| Three-provider managed Runs | **Partial.** Adapter tests and the opt-in harness can detect basic CLI/PTY launch failure, but the harness uses gate-disabled roles and private Server composition. | Basic process launch evidenced; governed public proof not met. |
| Parent/child/grandchild tree | **Yes** for topology; **no** for truthful `createdFromRunId` provenance. | Partial; Finding 9. |
| Delegation, interruption, stop-one, stop-tree | **Partial.** Happy paths and several deny/race cases exist, but real grant integration, target widening, spawn-vs-fence, and partial-stop resume are uncovered/broken. | Exit not met; Findings 3 and 6. |
| Continuation modes and adoption | **Yes** for basic modes, immutable family edges, and competing adoption; **no** for continuation per-stage crash/replay and integrated fence matrix. | Partial; Findings 5 and 7. |
| Recoverable stage journal | **No.** The production compensation path is broken and the fake/shared-port crash test cannot establish process recovery. | Exit not met; Findings 5 and 7. |
| Three-generation role/grant/fence/race matrix | **No.** The live harness covers roles/tree/continuation/happy stop, not the required grant and fence races. | Exit condition failed. |
| Per-stage spawn and continuation crash tests | **No.** Only write-count spawn injection exists; continuation and named before/after stage coverage are absent. | Exit condition failed. |

### Delegation

**Yes.** The public Agents capability can mint a grant over arbitrary `targetAgentIds` without proving those targets are inside the authenticated grantor's authority, and it accepts an arbitrary `issuerAgentRunId`; scope-name widening is rejected, but target/identity widening is not. In the actual child-spawn flow, receipt-key reuse then suppresses the parent-over-child grant altogether. The Agent Runtime fake masks both behaviors.

### Identity

A complete invalid credential is rejected, and a complete valid credential is attributed to its own Run. A partial or deliberately stripped credential is defaulted to “no Agent claim,” however, and therefore becomes the human principal with every human scope. Identity is consequently defaultable/confused even though direct token forgery is rejected.

### Fakes

**Yes.** Exit-relevant skills confirmation, PTY adoption/idempotency, Runtime authorization, grant issuance, provider-session behavior, and crash “restart” continuity depend on hand-written fakes that implement the desired rule. Several production counterexamples above are impossible in those fakes, so green tests do not independently prove the contract.

## Verdict

**B3b is NOT SAFE TO SEAL.** The two foundational infrastructure laws appear preserved, but the slice violates or fails to prove red gates 5, 6, 22, 24, and 26, permits an Agent-to-human privilege default, loses wire idempotency, has unsound delegation and stop-tree fencing, can accept an echoed skills prompt, and does not satisfy the §25 three-generation grant/fence/race or per-stage crash exit contract. These are production-contract failures plus invalid exit proof, not polish items; seal should wait for implementation repair and new non-tautological tests against the real seams.
