# Coding Standards — Novakai Analytics

## 10 design principles
1. Coupling — modules depend on each other minimally.
2. Cohesion — one module, one reason to exist.
3. Separation of concerns — different jobs, different places.
4. Information hiding — internals invisible; interfaces small.
5. Single responsibility — one reason to change.
6. Dependency direction — details depend on abstractions, not reverse.
7. DRY — one fact, one place.
8. YAGNI — no speculative flexibility.
9. Least surprise — code does what it looks like.
10. Composability — small parts combine cleanly.

First four are roots; rest are corollaries.

## 6 measurements

Scripts measure principles' symptoms.

| # | Measurement | Measures | How |
|---|---|---|---|
| 1 | Change amplification | coupling | small PRs touching many files (git) |
| 2 | Dependency structure | dependency direction | built-in import graph: cycles, god modules |
| 3 | Interface ratio | information hiding | exports ÷ implementation lines (TS AST) |
| 4 | Churn concentration | cohesion/SRP | same files edited forever (git) |
| 5 | Duplication | DRY | token clones (jscpd, built-in) |
| 6 | Rework rate | least surprise | fixes chasing features (git, gated on commit discipline ≥70%) |

Plus snapshot-only: cognitive complexity (Sonar metric via eslint-plugin-sonarjs, no server),
giant files/functions, dead exports, swallowed errors. 8 dimensions, green/amber/red bands.

Snapshot answers "designed well?" today. Git history adds hidden coupling + "getting worse?".

## How this repo applies them
- Pipeline: extract (git) + snapshot (code-as-is) → metrics → correlate. JSON files between stages.
- Metrics never touch git. Pure functions: Facts in, series out.
- One metric = one file, same signature.
- Impure shell (cli, git, fs, engines) at edges only.
- No frameworks. Deps = analysis engines only (typescript AST, eslint-plugin-sonarjs, jscpd).
- Git metrics: percentile thresholds. Snapshot: absolute bands — thresholds live in one file (bands.ts).
- Never fabricate numbers — "unconfigured" with reason; engine failure = skipped, never a clean 0.
- Unit of analysis for git metrics: merged PR, not raw commit. Intent from subject or branch name.

## Testing standards
- Vitest, colocated `*.test.ts`.
- Pure functions: fabricated fixtures, no mocks.
- Impure edges: one integration test each (temp dirs, cleaned up).
- Gate logic tested at the boundary (0.69 vs 0.70).
- Determinism: same input, same output — tested.
- `npm test` and `npm run typecheck` green before done.

## Repowise
External cause-side supplier — github.com/repowise-dev/repowise, AGPL.

- Covers hotspots, coupling, cycles, duplication.
- We read its export as `out/<repo>/repowise.json`.
- Never shell out to it.
- Missing file → cause side renders "unconfigured".
- Pilot before building anything it already covers.
