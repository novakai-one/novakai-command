# B3d cross-lane contract suites

These suites are frozen gates for later lane adapters, not B3d product-acceptance evidence.

- Each pair specifies provider facts and consumer observations at one of the four seams named by the freeze mission.
- The local fixtures self-test that the gate can accept a conforming adapter and reject the deliberately broken provider mutations recorded in the freeze report.
- A lane is not accepted merely because these fixture self-tests pass. Its real adapter must run the same exported suite through `@novakai/supervision/contract/testkit`.
- Reducer, scheduler, restart, boot-recovery, and full §25-B3d acceptance behavior remain builder work outside this contract-only freeze.
