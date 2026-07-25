/**
 * S1 surface manifest (law: tests cross the public contract). This test IS
 * the surface map for slice S1: it machine-reads the frozen contract source
 * (contract/messaging-contract.json, law #3) and asserts
 *   1. the contract still enumerates exactly the frozen catalogue
 *      (8 commands · 9 queries · 1 subscription · 4 events · 10 records ·
 *      13 errors) — drift here fails loudly, at the source;
 *   2. the generated public types mirror that source (errors, constants,
 *      records, feature vocabulary);
 *   3. the embedded composition root exposes EXACTLY the S1 surface — the
 *      direct lane (5 commands + 6 queries + GetCapabilities) plus the
 *      Subscribe stream — and every exposed operation names a contract
 *      operation. S2/S4 operations are absent from the door, not stubbed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  capabilityViewFeaturesValues,
  constants,
  createEmbeddedMessaging,
  DEFAULT_ROLE_GRANTS,
  errorCatalogue,
} from "../../public/index.js";

// dist/tests/contract/ -> package root is three levels up; the contract
// source lives beside the package (law #3 single source of truth).
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONTRACT_PATH = join(packageRoot, "..", "contract", "messaging-contract.json");

interface ContractSource {
  constants: Record<string, number>;
  records: Record<string, unknown>;
  commands: { name: string }[];
  queries: { name: string }[];
  subscriptions: { name: string }[];
  events: { name: string }[];
  errors: { name: string }[];
  $defs: { CapabilityView: { properties: { features: { items: { enum: string[] } } } } };
}

const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as ContractSource;

// The frozen catalogue (Step 2). If the contract source is amended on
// purpose, amend THIS map in the same change — that is the point of the law.
const FROZEN_COMMANDS = [
  "OpenPresence",
  "ClosePresence",
  "SendMessage",
  "SendFromTemplate",
  "SetDndPolicy",
  "SetContactPolicy",
  "UpsertTemplate",
  "RetireTemplate",
];
const FROZEN_QUERIES = [
  "GetThread",
  "ListThreadsForPerson",
  "GetMessages",
  "GetInbox",
  "GetDelivery",
  "GetPolicy",
  "ListTemplates",
  "GetPresence",
  "GetCapabilities",
];
const FROZEN_EVENTS = ["MessageCommitted", "DeliveryUpdated", "PresenceChanged", "PolicyChanged"];
const FROZEN_RECORDS = [
  "Message",
  "Thread",
  "Delivery",
  "DeliveryAttempt",
  "Presence",
  "ContactPolicy",
  "DndPolicy",
  "Template",
  "RecipientSnapshot",
  "AcceptanceRecord",
];
const FROZEN_ERRORS = [
  "NotAuthenticated",
  "NotAuthorized",
  "UnknownRecipient",
  "UnknownThread",
  "UnknownMessage",
  "BlockedByContactPolicy",
  "ValidationFailed",
  "TemplateNotFound",
  "TemplateFieldMismatch",
  "VersionUnsupported",
  "RateLimited",
  "IdempotencyConflict",
  "DependencyUnavailable",
];

/** The S1 door surface: session method → contract operation it crosses. */
const S1_SESSION_MAP: Record<string, { operation: string; kind: "command" | "query" | "subscription" }> = {
  sendMessage: { operation: "SendMessage", kind: "command" },
  openPresence: { operation: "OpenPresence", kind: "command" },
  closePresence: { operation: "ClosePresence", kind: "command" },
  setDndPolicy: { operation: "SetDndPolicy", kind: "command" },
  setContactPolicy: { operation: "SetContactPolicy", kind: "command" },
  getThread: { operation: "GetThread", kind: "query" },
  getMessages: { operation: "GetMessages", kind: "query" },
  getInbox: { operation: "GetInbox", kind: "query" },
  getDelivery: { operation: "GetDelivery", kind: "query" },
  getPolicy: { operation: "GetPolicy", kind: "query" },
  getPresence: { operation: "GetPresence", kind: "query" },
  subscribe: { operation: "Subscribe", kind: "subscription" },
};

/** S2/S4 surface: in the contract, deliberately NOT on the S1 door. */
const DEFERRED_OPERATIONS = [
  "SendFromTemplate",
  "UpsertTemplate",
  "RetireTemplate",
  "ListThreadsForPerson",
  "ListTemplates",
];

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("S1 surface manifest — the door matches the frozen contract", () => {
  it("the contract source enumerates exactly the frozen catalogue", () => {
    assert.deepEqual(sorted(contract.commands.map((entry) => entry.name)), sorted(FROZEN_COMMANDS));
    assert.deepEqual(sorted(contract.queries.map((entry) => entry.name)), sorted(FROZEN_QUERIES));
    assert.deepEqual(
      sorted(contract.subscriptions.map((entry) => entry.name)),
      sorted(["Subscribe"]),
    );
    assert.deepEqual(sorted(contract.events.map((entry) => entry.name)), sorted(FROZEN_EVENTS));
    assert.deepEqual(sorted(Object.keys(contract.records)), sorted(FROZEN_RECORDS));
    assert.deepEqual(sorted(contract.errors.map((entry) => entry.name)), sorted(FROZEN_ERRORS));
  });

  it("the generated public types mirror the contract source (law #3)", () => {
    assert.deepEqual(
      sorted(errorCatalogue.map((entry) => entry.name)),
      sorted(contract.errors.map((entry) => entry.name)),
      "the 13-error catalogue crosses unchanged",
    );
    for (const [name, value] of Object.entries(contract.constants)) {
      assert.equal(
        (constants as Record<string, number>)[name],
        value,
        `constant ${name} mirrors the contract source`,
      );
    }
    // L9: the feature vocabulary is checked against the contract SOURCE,
    // not a vacuous length check.
    assert.deepEqual(
      sorted([...capabilityViewFeaturesValues]),
      sorted(contract.$defs.CapabilityView.properties.features.items.enum),
      "the CapabilityView feature vocabulary mirrors the contract source exactly",
    );
  });

  it("the embedded door exposes EXACTLY the S1 surface, every operation named in the contract", async () => {
    const cap = createEmbeddedMessaging({
      authority: {
        principals: [{ token: "tok-alice", personId: "person_alice" as never, roles: ["Worker"] }],
        roleGrants: DEFAULT_ROLE_GRANTS,
      },
    });
    try {
      const auth = await cap.authenticate({ token: "tok-alice" });
      assert.equal(auth.kind, "authenticated");
      if (auth.kind !== "authenticated") return;
      const session = auth.session;

      const contractCommandNames = contract.commands.map((entry) => entry.name);
      const contractQueryNames = contract.queries.map((entry) => entry.name);
      const contractSubscriptionNames = contract.subscriptions.map((entry) => entry.name);

      // Every session operation is a real contract operation.
      const sessionOps = Object.keys(session).filter(
        (key) => !["principal", "state", "revalidate"].includes(key),
      );
      assert.deepEqual(
        sorted(sessionOps),
        sorted(Object.keys(S1_SESSION_MAP)),
        "the door exposes exactly the S1 operation set — no more, no less",
      );
      for (const method of sessionOps) {
        const mapping = S1_SESSION_MAP[method];
        assert.ok(mapping !== undefined, `${method} is mapped`);
        const catalogue =
          mapping.kind === "command"
            ? contractCommandNames
            : mapping.kind === "query"
              ? contractQueryNames
              : contractSubscriptionNames;
        assert.ok(
          catalogue.includes(mapping.operation),
          `${method} → ${mapping.operation} is a contract ${mapping.kind}`,
        );
        assert.equal(typeof session[method as keyof typeof session], "function");
      }

      // S2/S4 operations are in the contract but NOT on the S1 door.
      for (const deferred of DEFERRED_OPERATIONS) {
        const inContract =
          contractCommandNames.includes(deferred) || contractQueryNames.includes(deferred);
        assert.ok(inContract, `${deferred} is a known (deferred) contract operation`);
        assert.ok(
          !sessionOps.some((method) => S1_SESSION_MAP[method]?.operation === deferred),
          `${deferred} is absent from the S1 door (not stubbed)`,
        );
      }

      // GetCapabilities is the pre-auth discovery op (the 7th S1 query).
      const capabilities = cap.getCapabilities();
      assert.ok(contractQueryNames.includes("GetCapabilities"));
      assert.equal(capabilities.contractVersion, "1.0.0");
      assert.equal(capabilities.protocolVersion, "1.0.0");
    } finally {
      await cap.close();
    }
  });

  it("GetCapabilities advertises the S1 feature set with contract limits", () => {
    const cap = createEmbeddedMessaging({
      authority: {
        principals: [{ token: "tok-alice", personId: "person_alice" as never, roles: ["Worker"] }],
        roleGrants: DEFAULT_ROLE_GRANTS,
      },
    });
    const capabilities = cap.getCapabilities();
    assert.deepEqual(
      sorted(capabilities.features),
      sorted(["direct", "attention", "subscribe"]),
      "S1-c feature set: direct lane + attention mechanics + the Subscribe stream",
    );
    for (const feature of capabilities.features) {
      assert.ok(
        (capabilityViewFeaturesValues as readonly string[]).includes(feature),
        `${feature} is in the contract feature vocabulary`,
      );
    }
    assert.deepEqual(capabilities.limits, {
      messageMaxBytes: contract.constants["messageMaxBytes"],
      pageLimitMax: contract.constants["pageLimitMax"],
      subscriptionBufferMax: contract.constants["subscriptionBufferMax"],
    });
    void cap.close();
  });
});
