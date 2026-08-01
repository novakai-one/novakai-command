#!/usr/bin/env -S npx tsx
// nvk-agent-spawn — the command Chris kept assuming existed (DEC-B3V4-04, C-07).
//
// §17.1: "a compatibility executable that forwards byte-for-byte parsed
// arguments to `nvk agent spawn`. It owns no policy and has no separate
// implementation."
//
// Taken literally. It puts `spawn` in front of the arguments it was given and
// hands over to the real command IN THIS PROCESS. There is nothing here that
// can drift from `nvk-agent spawn`, because there is nothing here — which is
// the entire point of a compatibility door, and the reason red gate 23 stays
// green without anyone having to remember to update two files.
const [runtime, script, ...given] = process.argv;
process.argv = [runtime ?? '', script ?? '', 'spawn', ...given];

await import('./nvk-agent.js');
