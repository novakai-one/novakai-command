# NVK-KIMI-031 — B3b disposal re-audit

**Range:** `e4f7d7de..3b044ca2`  
**Method:** Fresh static audit of the diff, product source, changed tests, the three verifier reports, the NVK-KIMI-029 brief/todo, Pass 2, and Amendment 001. Per instruction, no suite or live-provider run was repeated.  
**Spec note:** the requested `amendment-001.md` does not exist at that spelling; this audit used the ratified `B3-v4-amendment-001.md`.  
**Output note:** the requested `Kimi-Work/build-reports` directory is outside the writable sandbox, so this report was written to the permitted worktree fallback.

## Verdict

**The disposal diff is NOT SAFE. B3b is NOT SAFE TO SEAL.**

Five of the nine disposal groups are substantially contract-correct, three are only partial, and P0-5 moves crash recovery from visibly stranded work to permanently quarantined work. The diff also introduces/exposes an authority-expiry failure: when a final Run issued more than one grant, only the first grant is actually expired. The two slice-voiding infrastructure laws remain intact, but §20 recovery, §5.3 grant lifetime, §24.4 second-host proof, and §25-B3b exit evidence do not.

## Findings

### SEVERE

1. **Boot “recovery” makes resumable spawn/continuation work permanently non-resumable:** restart changes every old non-final operation to `recovery-required` and adds an unconditional `uncertain` compensation; spawn refuses that state, continuation first refuses the now-final old Run, and repair refuses to close any operation carrying uncertainty. This contradicts “resume same operation and same reservation” and the recoverable-journal exit condition (`packages/agent-runtime/core/queries.ts:226-306`; `spawn.ts:53-68`; `continue.ts:53-71`; `repair.ts:126-157`; Pass 2 §13.1.6, §20 rows 1–2, §25-B3b).

2. **A final Run can leave live authority behind because grant expiry reuses one global idempotency key for every grant:** `expireGrantsOfRun` passes the same `context.clientOpId` to each update, while Foundation deduplicates by `clientOpId`; after the first update, later iterations return a replay without applying `status:"expired"`, yet all IDs are reported expired and callers discard the result (`packages/agents/b3/core/delegation.ts:296-315`; `packages/foundation/contract/api.ts:75-89,237-244`; `packages/agent-runtime/core/lifecycle.ts:287-294`; Pass 2 §5.3, §22).

3. **The governed-spawn Enter proof is non-causal:** the test’s scripted provider replies as soon as the first text write appears, during the production 250 ms pause and before the separate Enter write. The test therefore reaches `ready` even if Enter is never sent; its later assertion only inspects the implementation-generated write array (`packages/server/tests/b3b-governed-spawn.test.ts:62-75,169-210`; `packages/server/core/b3/run-ports.ts:290-313`; Pass 2 §24.2, §25-B3b).

4. **The claimed second-host proof still violates the second-host contract and is fake-owned by default:** it imports private Server host code and the fake provider factory, then its scripted provider derives and emits the exact gate answer from the launch plan. A non-empty shell transcript is labelled “real output” even in scripted mode. `--live` is optional and the mission todo records only generation 1 reaching the real Claude gate, not a real three-provider family (`scripts/automation-examples/b3b-three-generations.mjs:9-38,172-187,309-319`; `packages/agents/b3/adapters/providers/fake.ts:21-62`; Pass 2 §24.4, §25-B3b).

5. **The mandatory production-recovery crash proof is still absent:** the write-count spawn matrix does cover 0–14 injected store-write points, but its “restart” deliberately reuses the same in-memory Agents/Terminal/provider fakes and does not run the new host boot reconciler; the one real SIGKILL test proves only that labels cease to be `provisioning`/`running`. There is still no before/after continuation-stage crash matrix, and the boot behavior that would quarantine those operations is not exercised by the recovering unit matrix (`packages/agent-runtime/tests/failure-injection/crash-matrix.test.ts:51-102,108-168`; `packages/server/tests/b3b-boot-reconciliation.test.ts:63-143,185-228`; Pass 2 §24.3 item 3, §25-B3b).

### MEDIUM

6. **The delivery repair preserves submission boundaries but mutates arbitrary task content and generalises Claude-only measurements to all providers:** every production adapter imports `deliverAsOneLine` from the fake module; it replaces all newlines and blank lines before both the gate context and work brief are sent. Code, JSON, Markdown, or line-sensitive instructions can therefore change meaning. The conformance test checks that selected words survive and that all three adapters echo the same helper shape; it is not independent Codex/Kimi evidence (`packages/agents/b3/adapters/providers/fake.ts:167-196`; `claude.ts:28,178`; `codex.ts:31,203`; `kimi.ts:31,202`; `packages/agents/b3/tests/provider-conformance.test.ts:367-420`; Pass 2 §24.2).

7. **Delegation still treats `issuerAgentRunId` as the Run a grant is “for,” not the Run that issued it:** held grants are selected by `grant.issuerAgentRunId === principal.agentRunId`, and the public test explicitly ratifies that inversion. Pass 2 names this field as the issuer and binds expiry to the issuer becoming final. Automatic parent grants happen to use the same Run as issuer and holder, masking the mismatch; general public delegation cannot empower another Run without naming that other Run as the issuer (`packages/agents/b3/core/delegation.ts:45-62,106-123`; `packages/server/tests/b3b-public-recovery.test.ts:134-155`; Pass 2 §5.3, §12.7 `IssueDelegationGrantInput`, §22).

8. **The carried-forward native-subagent gate rule remains unimplemented:** all three adapters declare observation unavailable/B3c, and no Agent Runtime path emits or enforces `agent.run.subagent-skills-evidence.failed`. Amendment A-03 and §24.2 nevertheless put managed-only refusal, advisory success, and missing/mismatch failure in the carried-forward gate acceptance contract (`packages/agents/b3/adapters/providers/claude.ts:80-89`; `codex.ts:93-100`; `kimi.ts:96-105`; Pass 2 §24.2; Amendment 001 A-03).

### LOW

9. **The ClientOpId boundary accepts UUID versions 1–8 although the public format is UUIDv4:** the receipt fix is real, but validation is broader than §4.1 (`packages/server/core/b3/agent-methods.ts:63-82`; Pass 2 §4.1).

10. **Stop-tree confirmation expiry remains decorative:** prepare publishes `expiresAt`, but stop validates only a deterministic tree hash and never checks time, so an unchanged-tree token remains valid indefinitely (`packages/agent-runtime/core/stop-tree.ts:21-50,141-154`; Pass 2 §12.7 `StopTreeConfirmation`).

## The nine P0 disposals

| P0 | Result | Adversarial disposition |
|---|---|---|
| 1. Governed spawn | **PARTIAL** | Reading `nextInputSequence` after acquiring the lease and deriving per-effect/per-write keys are real fixes (`run-ports.ts:164-183,256-321`). The gate proof does not causally depend on Enter, and arbitrary briefs are flattened. |
| 2. Receipt idempotency | **REAL, LOW residue** | The caller’s `clientOpId` now reaches `contextFor`; black-box tests compare same-key identity and conflict behavior. Only the UUID-version validator is wrong (`agent-methods.ts:129-147`). |
| 3. Continuation identity | **REAL** | The replacement Run is reserved before launch and its own credential is injected; partial credentials are refused both client- and host-side (`continue-launch.ts:42-66`; `server/core/b3/client.ts:45-65`; `host.ts:75-87`). |
| 4. Parent grant | **PARTIAL / UNSAFE** | Separate derived effect keys and target-reach checks make the parent-over-child grant real (`spawn-stages.ts:241-282`; `delegation.ts:71-103`). Grant lifetime is broken for multiple grants, and issuer/holder semantics remain inverted. |
| 5. Crash recovery | **FAILED — problem moved** | Stale visible labels are removed and stale-lock reboot is exercised, but the replacement state cannot resume or repair and violates §20. |
| 6. Dead truth / runtime stop | **REAL** | Terminal inspection settles an exited process, Run inspection settles the Run with uncertainty, stale stop uses the expected live Run, and explicit Runtime stop terminates capability sessions before settling the epoch (`terminal/core/sessions.ts:177-224`; `agent-runtime/core/queries.ts:29-78`; `agent-runtime/core/compose.ts:217-255`). |
| 7. Public surfaces / tree | **REAL for the surfaces the spec actually requires** | §16.2 names are present, events are reachable with cursor gaps, and `getTree` returns the §12.7 Run-tree edges/max-depth projection. Its added direction/depth/supervision fields also expose the separate Agents-tree shape and are useful additive behavior (`agent-methods.ts:178-233`; `agent-runtime/core/tree.ts:28-162`; `server/tests/b3b-tree-surface.test.ts:116-182`). Several extra methods were invented, but they are additive. |
| 8. Gate echo / cycle / fence / repair / proof | **PARTIAL** | Marker-line matching, family provenance, adoption cycle rejection, spawn-vs-fence rejection, and partial stop resume are substantive. The gate and second-host exit proof remain invalid; native-subagent evidence also remains absent. |
| 9. Canonical CLI | **REAL** | `scripts/nvk.mjs` routes `agent`, `runtime`, and `terminal`, and the Agent CLI provides the canonical family including spawn and role creation (`scripts/nvk.mjs:10-36`; `packages/server/cli/nvk-agent.ts`). |

## Mandatory question 1 — tautology and hand-written fakes

**Yes: exit-relevant proofs still depend on rules owned by hand-written fakes.**

- The gate integration test injects the correct reply before Enter, so it proves that a supplied confirmation is accepted, not that a provider received a submitted turn.
- The provider-conformance test asks each adapter for its own delivery representation and asserts that representation has the newly implemented shape. It does not run Codex or Kimi.
- Agent Runtime’s runs fake concatenates delivery steps, decides that any `\r` means “submitted,” and manufactures the exact expected confirmation (`packages/agent-runtime/tests/runs-fakes.ts:126-144,232-244`). Those are precisely the exit-relevant rules under test.
- The default three-generation “proof” uses `confirmSkillsFromPlan`, whose shell script reads one line and prints the correct answer from the plan (`providers/fake.ts:45-62,90-102`).
- The boot tests assert that old labels disappear, which is an implementation echo compatible with permanent `recovery-required`; they never assert §20 resumption.
- The only grant-expiry test creates one grant, so it cannot expose global client-op deduplication suppressing grants 2..N (`packages/agents/b3/tests/delegation.test.ts:244-267`).
- The crash matrix’s shared fake Terminal owns adopt-by-operation behavior and its fake provider owns gate answers. This is useful deterministic injection, but it cannot establish recovery through the actual host boot path.

Not every new proof is tautological: same-key receipt identity/conflict, continuation socket identity, tree direction/topology/provenance, stale-stop CAS, adoption cycle refusal, and partial-stop outcomes assert observable contract claims against production cores. The failure is the attempt to promote fake-owned gate/recovery evidence into §25 exit evidence.

## Mandatory question 2 — which public surfaces are B3b exit items?

| Candidate surface | Contract decision | Classification |
|---|---|---|
| `b3.agent.issueDelegationGrant` | `issueDelegationGrant` is a normative **Agents package command** in §12.1/§12.7, while the authoritative socket inventory in §16.2 does not publish this wire name. Delegation behavior is B3b under §25 and §22. | The underlying package capability is B3b and exists. The exact `b3.agent.issueDelegationGrant` socket spelling is **not** a B3b exit item and is not reserved for a later slice; it is simply unspecified. Current `b3.agent.issueGrant` is an additive implementation extension. |
| `b3.agent.repairRunOperation` | `repairRunOperation` is a normative **Agent Runtime package command** in §12.2; §16.2 publishes no repair wire method. Recoverable operations are B3b under §20/§25. | The recovery behavior is B3b; the exact socket spelling is **not**. Current `b3.agent.repairOperation` is additive and cannot compensate for broken §20 recovery. |
| Public gate-confirmation submission | A-03 and §13.5 define confirmation as the provider’s turn-1 reply observed and validated by Runtime; neither §12 nor §16.2 publishes a caller submission command. | **No such public method is contracted.** Refusing to invent it was correct; it is not later-slice scope. A caller-forged confirmation would undermine the gate. |
| `getTree` edges / max depth | §16.2’s naming pattern maps `getTree` to §12.2 `getAgentRunTree`; §12.7’s `GetAgentRunTreeInput` carries `maxDepth` and `AgentRunTreeView` carries `edges`. §25 explicitly requires the family tree. | **B3b wire/exit-relevant.** The disposal is real: the current view returns edges and bounds traversal by max depth. |
| `getTree` direction / per-node depth | §12.1/§12.7 separately publish Agents capability `getAgentTree`, whose input has `direction` and whose `AgentTreeNode` has `depth/currentSupervision`. `GetAgentRunTreeInput`/`AgentRunTreeView` do not contain those fields, and §16.2 gives the Agents query no separate wire spelling. | **B3b package-contract behavior, but not an independently mandated `b3.agent.getTree` wire shape.** Adding them to the wire view is compatible and useful; their previous absence from that wire method was not by itself a §16.2 exit failure. |

The same rule applies to `getTreeFence`, `getLaunchPlan`, `listGrants`, and `listOperations`: useful additive surfaces are not retroactively §16.2 requirements. The mission brief correctly said to stop where the spec was silent; inventing names did not strengthen the normative exit contract.

## Mandatory question 3 — the two laws

- **Foundation-only persistence — PASS.** Agent Runtime and Agents still write their durable kinds only through Foundation scoped handles (`packages/agent-runtime/core/runs-store.ts:46-85`; `packages/agents/b3/core/store.ts:55-96`). The new event log is explicitly bounded and in-memory, and the run credential secret is Runtime-private material under `.novakai/runtime`, not a competing domain record. No new durable JSONL writer was introduced. This holds Amendment 001 A-01 and Pass 2 §§3.3–3.4/18.
- **nvk-ws v1 only — PASS.** Added methods remain entries in the existing method table and use `{id,method,params,v:1}` / `{id,result|error,v:1}` plus existing v1 event frames (`packages/server/contract/protocol.ts:1-58`; `packages/server/core/b3/agent-methods.ts:1-60`). No JSON-RPC 2.0 dialect or second socket framing appears. This holds Amendment 001 A-02 and Pass 2 §16.1.

## Mandatory question 4 — split-Enter across providers

**The split-Enter mechanism is contract-sound at the terminal seam; it is not, by itself, a Claude-only hack that visibly breaks Codex or Kimi. The associated all-provider proof and newline flattening are not contract-sound enough to seal.**

All three product adapters already declare carriage return as their native interactive submit boundary (`claude.ts:80-82`; `codex.ts:93-95`; `kimi.ts:96-98`). `typeAsRuntime` holds one input lease across the turn, emits ordered steps with distinct effect-derived keys, pauses between them, and releases afterward (`server/core/b3/run-ports.ts:256-321`). Separating text and CR therefore preserves the existing provider contract and prevents interleaving; no product-source counterexample shows the separation breaking the other two providers.

The overclaim is elsewhere:

- the 250 ms threshold was measured only against Claude;
- Codex and Kimi tests merely call the same shared helper and inspect its output;
- the helper is housed in `fake.ts` and imported by all production adapters;
- it flattens every turn, including the actual work brief, so it is not content-preserving for line-sensitive input;
- the governed integration fake answers before the split Enter is emitted.

Accordingly: **keep the ordered multi-step delivery seam; do not accept the present tests or universal one-line transformation as three-provider §24.2/§25 proof.**

## Seal decision

The diff contains worthwhile repairs, especially receipt propagation, continuation identity, stale/live truth, family traversal, fence/cycle handling, and CLI routing. They do not outweigh the blocking counterexamples.

**Disposal diff:** NOT SAFE.  
**B3b:** NOT SAFE TO SEAL.

Minimum re-entry evidence is: repair boot reconciliation so the §20 rows actually resume/reconcile the same operation; derive a distinct expiry key per grant and prove 2+ grants die with one Run; exercise crash/replay through the real host boot path for every spawn and continuation stage; replace the private/fake default second-host proof with a harness using only published contracts/CLI JSON; and add independent real-shape Codex/Kimi turn-delivery evidence without mutating line-sensitive briefs.
