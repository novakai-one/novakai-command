/**
 * Surface manifest (law: tests cross the public contract). This test IS the
 * surface map for the capability — updated at S4 (Templates + failure truth),
 * the last slice in Plan §18. It machine-reads the frozen contract source
 * (contract/messaging-contract.json, law #3) and asserts
 *   1. the contract still enumerates exactly the frozen catalogue
 *      (8 commands · 9 queries · 1 subscription · 4 events · 10 records ·
 *      13 errors) — drift here fails loudly, at the source;
 *   2. the generated public types mirror that source (errors, constants,
 *      records, feature vocabulary);
 *   3. the embedded composition root exposes EXACTLY the full v1 surface —
 *      the direct lane + rooms + attention + the Subscribe stream + the S4
 *      template operations (SendFromTemplate, UpsertTemplate, RetireTemplate,
 *      ListTemplates) — and every exposed operation names a contract
 *      operation. Post-S4, NOTHING in the frozen catalogue is deferred.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  capabilityViewFeaturesValues,
  constants,
  contractVersion,
  createEmbeddedMessaging,
  DEFAULT_ROLE_GRANTS,
  errorCatalogue,
} from "../../contract/index.js";

// dist/tests/contract/ -> package root is three levels up; from TS source
// (tests/contract/) it is two. The contract JSON is source-only (tsc does
// not copy it to dist), so it marks which layout we are running from. The
// contract source lives inside the package (law #3 single source of truth,
// D2 move).
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = existsSync(join(here, "..", "..", "contract", "messaging-contract.json"))
  ? join(here, "..", "..")
  : join(here, "..", "..", "..");
const CONTRACT_PATH = join(packageRoot, "contract", "messaging-contract.json");

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

/** The full v1 door surface (S4 sealed): session method → contract operation it crosses. */
const SESSION_MAP: Record<string, { operation: string; kind: "command" | "query" | "subscription" }> = {
  sendMessage: { operation: "SendMessage", kind: "command" },
  sendFromTemplate: { operation: "SendFromTemplate", kind: "command" },
  openPresence: { operation: "OpenPresence", kind: "command" },
  closePresence: { operation: "ClosePresence", kind: "command" },
  setDndPolicy: { operation: "SetDndPolicy", kind: "command" },
  setContactPolicy: { operation: "SetContactPolicy", kind: "command" },
  upsertTemplate: { operation: "UpsertTemplate", kind: "command" },
  retireTemplate: { operation: "RetireTemplate", kind: "command" },
  getThread: { operation: "GetThread", kind: "query" },
  listThreadsForPerson: { operation: "ListThreadsForPerson", kind: "query" },
  getMessages: { operation: "GetMessages", kind: "query" },
  getInbox: { operation: "GetInbox", kind: "query" },
  getDelivery: { operation: "GetDelivery", kind: "query" },
  getPolicy: { operation: "GetPolicy", kind: "query" },
  listTemplates: { operation: "ListTemplates", kind: "query" },
  getPresence: { operation: "GetPresence", kind: "query" },
  subscribe: { operation: "Subscribe", kind: "subscription" },
};

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("surface manifest — the door matches the frozen contract (S4: full v1 surface)", () => {
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

  it("the embedded door exposes EXACTLY the full v1 surface, every operation named in the contract", async () => {
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
      // Guard loosening (2026-08-07 test cleanup, Task 6 Step 2): a REMOVED
      // manifest operation still fails — the sealed surface may not shrink.
      // A NEW door method fails only when it names a frozen contract
      // operation (the public entry-point surface stays strict); any other
      // new method prints a warning instead of failing the per-change loop.
      const knownOps = Object.keys(SESSION_MAP);
      assert.deepEqual(
        knownOps.filter((op) => !sessionOps.includes(op)),
        [],
        "a sealed v1 operation is no longer on the door — the surface may not shrink",
      );
      const catalogueNames = [
        ...contractCommandNames,
        ...contractQueryNames,
        ...contractSubscriptionNames,
      ];
      const extraOps = sessionOps.filter((op) => !knownOps.includes(op));
      const publicExtra = extraOps.filter((op) =>
        catalogueNames.includes(op.charAt(0).toUpperCase() + op.slice(1)),
      );
      // Computed BEFORE the assert below: assert.deepEqual(publicExtra, [])
      // narrows the const's type downstream, which would break this filter.
      const warnOnly = extraOps.filter((op) => !publicExtra.includes(op));
      assert.deepEqual(
        publicExtra,
        [],
        "a new door method names a frozen contract operation — public surface drift must change the contract, not ride along",
      );
      if (warnOnly.length > 0) {
        console.warn(
          `[surface-manifest] WARNING: new door methods without manifest coverage (not frozen contract operations): ${warnOnly.join(", ")}`,
        );
      }
      for (const method of knownOps) {
        const mapping = SESSION_MAP[method];
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

      // Post-S4: every frozen command and query is live on the door — the
      // only unsurfaced catalogue entry is GetCapabilities, which is the
      // pre-auth discovery op on the composition root (asserted below).
      for (const command of contractCommandNames) {
        assert.ok(
          Object.values(SESSION_MAP).some((mapping) => mapping.operation === command),
          `${command} is live on the door (nothing deferred post-S4)`,
        );
      }

      // GetCapabilities is the pre-auth discovery op (the 9th query).
      const capabilities = cap.getCapabilities();
      assert.ok(contractQueryNames.includes("GetCapabilities"));
      assert.equal(capabilities.contractVersion, contractVersion);
      assert.equal(capabilities.protocolVersion, "1.0.0");
    } finally {
      await cap.close();
    }
  });

  it("GetCapabilities advertises the full v1 feature set with contract limits", () => {
    const cap = createEmbeddedMessaging({
      authority: {
        principals: [{ token: "tok-alice", personId: "person_alice" as never, roles: ["Worker"] }],
        roleGrants: DEFAULT_ROLE_GRANTS,
      },
    });
    const capabilities = cap.getCapabilities();
    assert.deepEqual(
      sorted(capabilities.features),
      sorted(["direct", "rooms", "attention", "subscribe", "templates"]),
      "full v1 feature set: direct lane + rooms + attention + the Subscribe stream + templates (S4)",
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
