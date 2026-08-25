/**
 * Templates (S4, DEC-15, R12, I10 — MSG-017 proof): the template commands and
 * SendFromTemplate through the public contract. MSG-017: "Message templates
 * with schema-bound fields can be created and sent" — the template send
 * validates fields against the Message schema by RENDERING into the R12
 * allowlisted paths and crossing the SAME door + decision point as
 * SendMessage (the tests below drive the embedded root, the same seam
 * consumers cross).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  constants,
  createEmbeddedMessaging,
  createMemoryPresenceTransport,
  createSeededClock,
  DEFAULT_ROLE_GRANTS,
  templateBindablePaths,
} from "../../contract/index.js";
import type {
  EmbeddedMessaging,
  MessagingSession,
  TemplateBinding,
} from "../../contract/index.js";
import {
  ADMIN,
  ALICE,
  BOB,
  ManualScheduler,
  TEST_RETRY_POLICY,
  expectError,
  sendInput,
  sessionFor,
  unwrap,
} from "./helpers.js";

/** A template.write holder (ADMIN) plus two Workers; otherwise the P6 wiring. */
function makeCap(): { cap: EmbeddedMessaging } {
  const clock = createSeededClock({ seed: "templates" });
  const transport = createMemoryPresenceTransport({ kind: "ws" });
  const cap = createEmbeddedMessaging({
    clock,
    transports: [transport],
    scheduler: new ManualScheduler(),
    retryPolicy: TEST_RETRY_POLICY,
    authority: {
      principals: [
        { token: "tok-alice", personId: ALICE, roles: ["Worker"] },
        { token: "tok-bob", personId: BOB, roles: ["Worker"] },
        { token: "tok-admin", personId: ADMIN, grants: ["template.write"] },
      ],
      roleGrants: DEFAULT_ROLE_GRANTS,
    },
  });
  return { cap };
}

const STANDUP_BINDINGS: TemplateBinding[] = [
  { field: "summary", path: "body.text" },
  { field: "title", path: "body.subject" },
  { field: "ticket", path: "body.fields.ticket" },
];

async function createStandup(admin: MessagingSession): Promise<string> {
  const created = unwrap(
    await admin.upsertTemplate({ name: "standup", bindings: STANDUP_BINDINGS }),
  );
  return created.templateId;
}

describe("templates (DEC-15, R12, I10) — MSG-017", () => {
  it("create → send from template → rendered into allowlisted paths, stamped with the TemplateRef, delivered as SendMessage", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));
    await bob.openPresence({ transport: "ws" });

    const created = unwrap(await admin.upsertTemplate({ name: "standup", bindings: STANDUP_BINDINGS }));
    assert.ok(created.templateId.startsWith("template_"));
    assert.equal(created.revision, 1);

    const accepted = unwrap(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId: created.templateId,
        fields: { summary: "shipped S4", title: "standup", ticket: "MSG-017" },
        priority: "normal",
        clientMessageId: "tpl-1",
      }),
    );
    assert.ok(accepted.messageId.startsWith("message_"));

    // The rendered Message: every allowlisted path rendered, core-owned
    // fields owned by the core, the TemplateRef stamped verbatim (I10).
    const page = unwrap(await bob.getMessages({ threadId: accepted.threadId }));
    const message = page.messages.find((candidate) => candidate.id === accepted.messageId);
    assert.ok(message);
    assert.equal(message.body.text, "shipped S4");
    assert.equal(message.body.subject, "standup");
    assert.deepEqual(message.body.fields, { ticket: "MSG-017" });
    assert.deepEqual(message.template, {
      templateId: created.templateId,
      fields: { summary: "shipped S4", title: "standup", ticket: "MSG-017" },
    });
    assert.equal(message.senderId, ALICE, "sender identity from authentication, never the template");

    // Accepted EXACTLY as SendMessage: same delivery lane, real adapter effect.
    const deliveries = unwrap(await alice.getDelivery({ messageId: accepted.messageId }));
    assert.equal(deliveries.deliveries[0]?.state, "delivered");
    await cap.close();
  });

  it("R12: bindings outside templateBindablePaths are ValidationFailed at upsert — the allowlist is the contract's own", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");

    // Law #3: the allowlist comes from the contract source (generated), and
    // core-owned paths are NOT in it.
    for (const coreOwned of ["id", "senderId", "threadId", "sequence", "createdAt", "clientMessageId", "template"]) {
      assert.ok(!(templateBindablePaths as readonly string[]).includes(coreOwned));
    }

    for (const badPath of ["senderId", "threadId", "id", "sequence", "body.nope", "body.fields", "template"]) {
      const error = expectError(
        await admin.upsertTemplate({ name: "evil", bindings: [{ field: "x", path: badPath }] }),
      );
      assert.equal(error.name, "ValidationFailed", `${badPath} rejected`);
      const issues = (error.fields as { issues?: { path: string; message: string }[] }).issues ?? [];
      assert.ok(
        issues.some((issue) => issue.message.includes("templateBindablePaths")),
        `${badPath}: the issue names the R12 allowlist`,
      );
    }

    // Every allowlisted literal + the fields pattern IS accepted.
    const ok = unwrap(
      await admin.upsertTemplate({
        name: "all-paths",
        bindings: [
          { field: "t", path: "body.text" },
          { field: "s", path: "body.subject" },
          { field: "f", path: "body.format" },
          { field: "c", path: "body.fields.custom" },
          { field: "p", path: "priority" },
        ],
      }),
    );
    assert.equal(ok.revision, 1);
    await cap.close();
  });

  it("duplicate binding fields or duplicate target paths are ValidationFailed", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const dupField = expectError(
      await admin.upsertTemplate({
        name: "dup",
        bindings: [
          { field: "x", path: "body.text" },
          { field: "x", path: "body.subject" },
        ],
      }),
    );
    assert.equal(dupField.name, "ValidationFailed");
    const dupPath = expectError(
      await admin.upsertTemplate({
        name: "dup",
        bindings: [
          { field: "a", path: "body.text" },
          { field: "b", path: "body.text" },
        ],
      }),
    );
    assert.equal(dupPath.name, "ValidationFailed");
    await cap.close();
  });

  it("authorization: UpsertTemplate/RetireTemplate require the template.write grant", async () => {
    const { cap } = makeCap();
    const alice = await sessionFor(cap, "tok-alice"); // Worker: no template.write
    const admin = await sessionFor(cap, "tok-admin");

    const denied = expectError(await alice.upsertTemplate({ name: "nope", bindings: STANDUP_BINDINGS }));
    assert.equal(denied.name, "NotAuthorized");
    assert.equal((denied.fields as { requiredGrant?: string }).requiredGrant, "template.write");

    const templateId = await createStandup(admin);
    const deniedRetire = expectError(await alice.retireTemplate({ templateId }));
    assert.equal(deniedRetire.name, "NotAuthorized");
    await cap.close();
  });

  it("TemplateFieldMismatch: missing or extra fields against the declared bindings (DEC-15)", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));
    const templateId = await createStandup(admin);

    const missing = expectError(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId,
        fields: { summary: "x", title: "y" }, // ticket missing
        priority: "normal",
        clientMessageId: "tpl-missing",
      }),
    );
    assert.equal(missing.name, "TemplateFieldMismatch");

    const extra = expectError(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId,
        fields: { summary: "x", title: "y", ticket: "z", hacker: "w" },
        priority: "normal",
        clientMessageId: "tpl-extra",
      }),
    );
    assert.equal(extra.name, "TemplateFieldMismatch");
    await cap.close();
  });

  it("the rendered send validates as SendMessage: a bad field value is ValidationFailed, not a template bypass", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));
    const templateId = await createStandup(admin);

    const error = expectError(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId,
        fields: { summary: 42, title: "y", ticket: "z" }, // body.text must be a non-empty string
        priority: "normal",
        clientMessageId: "tpl-badvalue",
      }),
    );
    assert.equal(error.name, "ValidationFailed");
    await cap.close();
  });

  it("a priority binding renders priority; an invalid value fails the same door", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));

    const created = unwrap(
      await admin.upsertTemplate({
        name: "page",
        bindings: [
          { field: "text", path: "body.text" },
          { field: "level", path: "priority" },
        ],
      }),
    );
    const accepted = unwrap(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId: created.templateId,
        fields: { text: "wake up", level: "urgent" },
        priority: "normal", // the template's priority binding wins — it IS the render
        clientMessageId: "tpl-prio",
      }),
    );
    const page = unwrap(await alice.getMessages({ threadId: accepted.threadId }));
    assert.equal(page.messages[0]?.priority, "urgent");

    const bad = expectError(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId: created.templateId,
        fields: { text: "wake up", level: "critical" },
        priority: "normal",
        clientMessageId: "tpl-prio-bad",
      }),
    );
    assert.equal(bad.name, "ValidationFailed", "the rendered priority must be a contract Priority");
    await cap.close();
  });

  it("unknown and retired templates reject new sends with TemplateNotFound; history is unchanged (I10)", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));
    const templateId = await createStandup(admin);

    const unknown = expectError(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId: "template_ghost" as never,
        fields: {},
        priority: "normal",
        clientMessageId: "tpl-unknown",
      }),
    );
    assert.equal(unknown.name, "TemplateNotFound");

    // Send once, THEN retire: the historical Message keeps its TemplateRef.
    const sent = unwrap(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId,
        fields: { summary: "before retire", title: "t", ticket: "k" },
        priority: "normal",
        clientMessageId: "tpl-history",
      }),
    );
    unwrap(await admin.retireTemplate({ templateId }));

    const after = expectError(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId,
        fields: { summary: "after retire", title: "t", ticket: "k" },
        priority: "normal",
        clientMessageId: "tpl-after-retire",
      }),
    );
    assert.equal(after.name, "TemplateNotFound");

    const history = unwrap(await alice.getMessages({ threadId: sent.threadId }));
    assert.equal(history.messages[0]?.template?.templateId, templateId, "history unchanged (I10)");
    assert.equal(history.messages[0]?.body.text, "before retire");

    // Re-retire is idempotent (already in the desired end state).
    unwrap(await admin.retireTemplate({ templateId }));
    // Retiring an unknown template is TemplateNotFound.
    assert.equal(
      expectError(await admin.retireTemplate({ templateId: "template_ghost" as never })).name,
      "TemplateNotFound",
    );
    await cap.close();
  });

  it("DEC-13: a same-key retry after RETIREMENT returns the original acceptance — a retry is never re-judged", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));
    const templateId = await createStandup(admin);

    const input = {
      address: `person:${BOB}`,
      templateId,
      fields: { summary: "s", title: "t", ticket: "k" },
      priority: "normal",
      clientMessageId: "tpl-retry",
    };
    const first = unwrap(await alice.sendFromTemplate(input));
    unwrap(await admin.retireTemplate({ templateId }));

    const retry = unwrap(await alice.sendFromTemplate(input));
    assert.equal(retry.duplicate, true);
    assert.equal(retry.messageId, first.messageId, "the ORIGINAL acceptance, not TemplateNotFound");

    // A5: same key, different template fields → IdempotencyConflict.
    const conflict = expectError(
      await alice.sendFromTemplate({ ...input, fields: { summary: "different", title: "t", ticket: "k" } }),
    );
    assert.equal(conflict.name, "IdempotencyConflict");
    await cap.close();
  });

  it("revise bumps the revision via the store CAS; revising an unknown id is ValidationFailed; retirement is one-way", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const templateId = await createStandup(admin);

    const revised = unwrap(
      await admin.upsertTemplate({
        templateId: templateId as never,
        name: "standup v2",
        description: "now with a subject",
        bindings: STANDUP_BINDINGS,
      }),
    );
    assert.equal(revised.revision, 2);

    const missing = expectError(
      await admin.upsertTemplate({
        templateId: "template_ghost" as never,
        name: "ghost",
        bindings: STANDUP_BINDINGS,
      }),
    );
    assert.equal(missing.name, "ValidationFailed");

    // I10: a revise never resurrects a retired template.
    unwrap(await admin.retireTemplate({ templateId }));
    unwrap(
      await admin.upsertTemplate({
        templateId: templateId as never,
        name: "standup v3",
        bindings: STANDUP_BINDINGS,
      }),
    );
    const listed = unwrap(await admin.listTemplates({ includeRetired: true }));
    const template = listed.templates.find((candidate) => candidate.id === templateId);
    assert.equal(template?.retired, true, "retirement is one-way in v1");
    // create (1) → revise (2) → retire (3) → revise (4): the CAS chain holds.
    assert.equal(template?.revision, 4);
    await cap.close();
  });

  it("ListTemplates: any authenticated principal; retired excluded by default; pagination walks without loss or duplication", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const alice = await sessionFor(cap, "tok-alice");

    const ids: string[] = [];
    for (const name of ["t1", "t2", "t3"]) {
      const created = unwrap(await admin.upsertTemplate({ name, bindings: STANDUP_BINDINGS }));
      ids.push(created.templateId);
    }
    unwrap(await admin.retireTemplate({ templateId: ids[1] as never }));

    // Any authenticated principal (R3) — a Worker lists too.
    const visible = unwrap(await alice.listTemplates({}));
    assert.deepEqual(visible.templates.map((template) => template.name).sort(), ["t1", "t3"]);

    const everything = unwrap(await alice.listTemplates({ includeRetired: true }));
    assert.equal(everything.templates.length, 3);

    // Pagination: limit 1, walk the cursors — no template repeated or skipped.
    const walked: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = unwrap(
        await alice.listTemplates({
          includeRetired: true,
          limit: 1,
          ...(cursor !== undefined ? { cursor: cursor as never } : {}),
        }),
      );
      walked.push(...page.templates.map((template) => template.id));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    assert.equal(walked.length, 3);
    assert.equal(new Set(walked).size, 3);

    // Malformed cursor → the door's ValidationFailed (shared cursor machinery).
    assert.equal(
      expectError(await alice.listTemplates({ cursor: "not-a-cursor" as never })).name,
      "ValidationFailed",
    );
    await cap.close();
  });

  it("idempotent retry of the SAME template request returns duplicate:true (A5, DEC-13)", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));
    const templateId = await createStandup(admin);

    const input = {
      address: `person:${BOB}`,
      templateId,
      fields: { summary: "s", title: "t", ticket: "k" },
      priority: "normal",
      clientMessageId: "tpl-dup",
    };
    const first = unwrap(await alice.sendFromTemplate(input));
    const second = unwrap(await alice.sendFromTemplate(input));
    assert.equal(second.duplicate, true);
    assert.equal(second.messageId, first.messageId);

    const page = unwrap(await alice.getMessages({ threadId: first.threadId }));
    assert.equal(page.messages.length, 1, "no duplicate Message (I1)");
    await cap.close();
  });

  it("a template send hits the same policy door: contact policy blocks exactly as SendMessage", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const alice = await sessionFor(cap, "tok-alice");
    const templateId = await createStandup(admin);

    // Bob never allowlisted Alice: the rendered send is judged by decideSend
    // like any other — BlockedByContactPolicy, the direct-send error (R4).
    const blocked = expectError(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId,
        fields: { summary: "unsolicited", title: "t", ticket: "k" },
        priority: "normal",
        clientMessageId: "tpl-blocked",
      }),
    );
    assert.equal(blocked.name, "BlockedByContactPolicy");

    // And a plain SendMessage with an unknown key still fails the door parse.
    assert.equal(expectError(await alice.sendMessage({ ...sendInput(`person:${BOB}`, "x", "cm-x"), from: "me" })).name, "ValidationFailed");
    await cap.close();
  });

  it("F1: the DEC-15 field match is own-key — a template declaring `constructor`/`toString`, sent without them, is TemplateFieldMismatch", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));

    const created = unwrap(
      await admin.upsertTemplate({
        name: "proto-fields",
        bindings: [
          { field: "constructor", path: "body.text" },
          { field: "toString", path: "body.subject" },
        ],
      }),
    );

    // `constructor`/`toString` resolve via Object.prototype on EVERY object —
    // an `in`-based match looked satisfied by EMPTY fields (audit F1 repro).
    const mismatch = expectError(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId: created.templateId,
        fields: {},
        priority: "normal",
        clientMessageId: "f1-empty",
      }),
    );
    assert.equal(mismatch.name, "TemplateFieldMismatch");

    // Supplied as own keys, the same fields render normally.
    const accepted = unwrap(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId: created.templateId,
        fields: { constructor: "own-key text", toString: "own-key subject" },
        priority: "normal",
        clientMessageId: "f1-own",
      }),
    );
    const page = unwrap(await alice.getMessages({ threadId: accepted.threadId }));
    assert.equal(page.messages[0]?.body.text, "own-key text");
    assert.equal(page.messages[0]?.body.subject, "own-key subject");
    await cap.close();
  });

  it("F2: R12 rejects prototype-pollution segments and the pattern literal; a normal body.fields key still renders", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");
    const alice = await sessionFor(cap, "tok-alice");
    const bob = await sessionFor(cap, "tok-bob");
    unwrap(await bob.setContactPolicy({ allowlist: [ALICE], defaultRule: "deny" }));

    for (const badPath of [
      "body.fields.__proto__", // rendered into a plain object this MUTATED the prototype — the value vanished (audit F2 repro)
      "body.fields.constructor",
      "body.fields.prototype",
      "body.fields.<name>", // the pattern literal is a marker, not a field key
    ]) {
      const error = expectError(
        await admin.upsertTemplate({ name: "evil", bindings: [{ field: "x", path: badPath }] }),
      );
      assert.equal(error.name, "ValidationFailed", `${badPath} rejected`);
    }

    // A normal custom-field binding is untouched by the rejection list.
    const created = unwrap(
      await admin.upsertTemplate({
        name: "custom-field",
        bindings: [
          { field: "summary", path: "body.text" },
          { field: "ticket", path: "body.fields.ticket" },
        ],
      }),
    );
    const accepted = unwrap(
      await alice.sendFromTemplate({
        address: `person:${BOB}`,
        templateId: created.templateId,
        fields: { summary: "renders fine", ticket: "MSG-017" },
        priority: "normal",
        clientMessageId: "f2-normal",
      }),
    );
    const page = unwrap(await alice.getMessages({ threadId: accepted.threadId }));
    assert.equal(page.messages[0]?.body.text, "renders fine");
    assert.deepEqual(page.messages[0]?.body.fields, { ticket: "MSG-017" });
    await cap.close();
  });

  it("F3: ListTemplates honors limit as a HARD bound over a filtered stream — limit:2 returns exactly 2 + nextCursor", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");

    // t2 retired: with the filter on, the old push-a-whole-page loop returned
    // THREE templates for limit:2 (audit F3 repro).
    const ids: string[] = [];
    for (const name of ["t1", "t2", "t3", "t4"]) {
      const created = unwrap(await admin.upsertTemplate({ name, bindings: STANDUP_BINDINGS }));
      ids.push(created.templateId);
    }
    unwrap(await admin.retireTemplate({ templateId: ids[1] as never }));

    const page = unwrap(await admin.listTemplates({ limit: 2 }));
    assert.equal(page.templates.length, 2, "the limit is a hard bound, never overshot");
    assert.deepEqual(page.templates.map((template) => template.name), ["t1", "t3"]);
    assert.ok(page.nextCursor !== undefined, "more visible templates remain behind a cursor");

    // The cursor walk loses nothing and repeats nothing.
    const rest = unwrap(await admin.listTemplates({ limit: 2, cursor: page.nextCursor as never }));
    assert.deepEqual(rest.templates.map((template) => template.name), ["t4"]);
    assert.equal(rest.nextCursor, undefined);
    await cap.close();
  });

  it("F3: an omitted limit returns ONE bounded page (constants.pageLimitMax) — never a store drain", async () => {
    const { cap } = makeCap();
    const admin = await sessionFor(cap, "tok-admin");

    for (let i = 0; i < 205; i += 1) {
      unwrap(await admin.upsertTemplate({ name: `bulk-${String(i)}`, bindings: STANDUP_BINDINGS }));
    }
    const page = unwrap(await admin.listTemplates({}));
    assert.equal(page.templates.length, constants.pageLimitMax, "one bounded page, like GetMessages");
    assert.ok(page.nextCursor !== undefined, "the remainder sits behind a cursor");

    const tail = unwrap(await admin.listTemplates({ cursor: page.nextCursor as never }));
    assert.equal(tail.templates.length, 5);
    assert.equal(tail.nextCursor, undefined);
    await cap.close();
  });
});
