/**
 * B3c — the two new journal kinds must not leak into the v1 event stream.
 *
 * The v1 Subscribe stream has exactly three public facts (MessageCommitted,
 * DeliveryUpdated, PolicyChanged) and both projections were written as a
 * two-branch ternary with PolicyChanged as the fall-through. Adding a journal
 * kind therefore does not fail loudly — it silently produces a PolicyChanged
 * event whose personId/policy/revision are all `undefined`, delivered to every
 * v1 subscriber that asked for policy changes.
 *
 * These are unit tests over the projection itself rather than a live
 * subscription, because the failure is in the mapping and nothing else: a
 * subscription test would prove the same thing through three more layers.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { projectJournalEntry } from "../../core/journalProjection.js";
import type { JournalEntry } from "../../contract/ports/store.js";
import type { Sequence } from "../../contract/schemas.js";
import type {
  AgentEndpointClaim,
  AgentEndpointClaimId,
  AgentId,
  AgentInboxItem,
  AgentInboxItemId,
  AgentRunId,
  MessagingStoreOpId,
  TerminalSessionId,
} from "../contract/records.js";
import type { MessageId } from "../../contract/schemas.js";

const CLAIM: AgentEndpointClaim = {
  id: "agentEndpoint_x" as AgentEndpointClaimId,
  kind: "agentEndpointClaim",
  schemaVersion: 1,
  entityRevision: 1,
  createdAt: "2026-08-02T00:00:00.000Z",
  permissionLevel: "private",
  createdBy: "sys_agent_runtime",
  lastStoreOpId: "messagingStoreOp_x" as MessagingStoreOpId,
  agentId: "agent_a" as AgentId,
  agentRunId: "agentRun_1" as AgentRunId,
  terminalSessionId: "terminal_1" as TerminalSessionId,
  endpointGeneration: 0,
  state: "active",
};

const ITEM: AgentInboxItem = {
  id: "agentInbox_x" as AgentInboxItemId,
  kind: "agentInboxItem",
  schemaVersion: 1,
  entityRevision: 1,
  createdAt: "2026-08-02T00:00:00.000Z",
  permissionLevel: "private",
  createdBy: "person_chris",
  lastStoreOpId: "messagingStoreOp_x" as MessagingStoreOpId,
  agentId: "agent_a" as AgentId,
  messageId: "message_1" as MessageId,
  acceptedSequence: 1,
  state: "queued",
};

test("an AgentEndpointChanged journal entry produces no v1 public fact", () => {
  const entry: JournalEntry = {
    sequence: 4 as Sequence, kind: "AgentEndpointChanged", claim: CLAIM,
  };
  assert.equal(projectJournalEntry(entry), null);
});

test("an AgentInboxChanged journal entry produces no v1 public fact", () => {
  const entry: JournalEntry = {
    sequence: 5 as Sequence, kind: "AgentInboxChanged", item: ITEM,
  };
  assert.equal(projectJournalEntry(entry), null);
});

test("TemplateWritten still produces no v1 public fact", () => {
  const entry: JournalEntry = {
    sequence: 6 as Sequence,
    kind: "TemplateWritten",
    template: {
      id: "template_1", kind: "template", schemaVersion: 1,
      createdAt: "2026-08-02T00:00:00.000Z", name: "t", bindings: [],
      retired: false, revision: 1,
    } as unknown as never,
  };
  assert.equal(projectJournalEntry(entry), null);
});

test("PolicyChanged still projects with its own fields intact", () => {
  // The regression this guards: with a fall-through ternary, ANY unmapped kind
  // became a PolicyChanged carrying three undefined fields. Proving the real
  // one still works is what makes the two nulls above meaningful.
  const entry: JournalEntry = {
    sequence: 7 as Sequence,
    kind: "PolicyChanged",
    personId: "person_chris" as never,
    policy: "dnd",
    revision: 3,
  };
  const fact = projectJournalEntry(entry);
  assert.equal(fact?.kind, "PolicyChanged");
  if (fact?.kind !== "PolicyChanged") return;
  assert.equal(fact.event.personId, "person_chris");
  assert.equal(fact.event.policy, "dnd");
  assert.equal(fact.event.revision, 3);
});
