/**
 * Templates — DEC-15, R12, I10 (slice S4).
 *
 * A Template declares named fields bound to paths in the Message schema.
 * SendFromTemplate renders the caller's field values into those paths and the
 * rendered send crosses the SAME door and the SAME single decision point as
 * SendMessage (decideSend) — templates cannot drift from the contract
 * (DEC-15), and no template-specific policy exists anywhere.
 *
 * R12 (the allowlist): bindings may target templateBindablePaths ONLY —
 * sourced from generated.ts, which the codegen emits FROM the contract JSON
 * (law #3; never hand-copied). Everything else on Message is core-owned: id,
 * kind, schemaVersion, createdAt, sequence, threadId, senderId,
 * clientMessageId, template, and all delivery metadata. The rule is enforced
 * TWICE, in this one module: at UpsertTemplate (a non-bindable path is
 * ValidationFailed) and again at render (defense in depth — a template that
 * reached the store by any path still cannot render outside the allowlist).
 *
 * DEC-13 honesty: the A5 requestHash covers the TEMPLATE request (address,
 * templateId, fields, priority — Store-Seam §2), so a same-key + same-content
 * retry returns the original acceptance WITHOUT re-loading the template — a
 * retry is never re-judged by a later revision or retirement. Template
 * loading/rendering runs only after the idempotency pre-check misses
 * (sendPipeline's shared executor orders this).
 *
 * I10: retirement is one-way in v1 — UpsertTemplate preserves `retired` on
 * revise (there is no un-retire op); retired/unknown templates reject new
 * sends with TemplateNotFound; history (Messages carrying the TemplateRef)
 * is never rewritten.
 *
 * Authorization (frozen contract): UpsertTemplate and RetireTemplate require
 * the template.write grant; SendFromTemplate is authorized exactly as
 * SendMessage; ListTemplates is any authenticated principal (queries.ts).
 */

import { schemaVersion, templateBindablePaths } from "../contract/schemas.js";
import { MessagingError } from "../contract/schemas.js";
import type {
  SendFromTemplateInput,
  SendMessageInput,
  Template,
  TemplateBinding,
  TemplateId,
  TemplateRef,
  TemplateUpserted,
  UpsertTemplateInput,
  RetireTemplateInput,
  ValidationIssue,
} from "../contract/schemas.js";
import type { Principal } from "../contract/ports/authority.js";
import type { MessagingStore } from "../contract/ports/store.js";
import type { ClockIds } from "../contract/ports/clock.js";
import { parseSendMessageInput, validationFailedError } from "./validate.js";
import { storeDependencyError } from "./storeErrors.js";

/** Bounded re-decide loop for RevisionConflict (Store-Seam §6 core handling). */
const MAX_REVISION_RETRIES = 3;

/**
 * Segments that may never name a custom field: the prototype-pollution
 * vocabulary. Rendered into a plain object, `__proto__` would MUTATE the
 * prototype instead of creating an own key (the supplied value would vanish
 * with no error); `constructor`/`prototype` are rejected with it so no
 * binding path can ever name an inherited member (audit F2).
 */
const FORBIDDEN_FIELD_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * R12: a binding path is bindable when it is literally one of the plain
 * allowlist entries, or matches a `<name>` pattern entry with a non-empty,
 * non-forbidden name segment (the contract's `body.fields.<name>` — any
 * single custom field key under body.fields). A pattern entry itself
 * (`body.fields.<name>` verbatim) is NOT bindable — `<name>` is a pattern
 * marker, not a field key (audit F2).
 */
export function isBindablePath(path: string): boolean {
  for (const entry of templateBindablePaths) {
    const markerAt = entry.indexOf("<name>");
    if (markerAt < 0) {
      // A literal allowlist entry binds by exact match only.
      if (entry === path) return true;
      continue;
    }
    const prefix = entry.slice(0, markerAt);
    const suffix = entry.slice(markerAt + "<name>".length);
    if (path.startsWith(prefix) && path.endsWith(suffix)) {
      const name = path.slice(prefix.length, path.length - suffix.length);
      if (name.length > 0 && name !== "<name>" && !FORBIDDEN_FIELD_SEGMENTS.has(name)) return true;
    }
  }
  return false;
}

function templateNotFound(templateId: TemplateId): MessagingError {
  return new MessagingError("TemplateNotFound", {
    message: `no such template, or it is retired: ${templateId}`,
    retryable: false,
    fields: { templateId },
  });
}

/** R12 + shape rules for a bindings array; the issues for a ValidationFailed. */
function bindingIssues(bindings: TemplateBinding[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenFields = new Set<string>();
  const seenPaths = new Set<string>();
  bindings.forEach((binding, index) => {
    if (!isBindablePath(binding.path)) {
      issues.push({
        path: `bindings[${index}].path`,
        message: `${binding.path} is not in templateBindablePaths (R12)`,
      });
    }
    if (seenFields.has(binding.field)) {
      issues.push({ path: `bindings[${index}].field`, message: "duplicate field name" });
    }
    if (seenPaths.has(binding.path)) {
      issues.push({ path: `bindings[${index}].path`, message: "duplicate target path" });
    }
    seenFields.add(binding.field);
    seenPaths.add(binding.path);
  });
  return issues;
}

export interface RenderedTemplateSend {
  command: SendMessageInput;
  templateRef: TemplateRef;
}

/**
 * Load + validate + render a SendFromTemplate request into a SendMessageInput
 * (DEC-15). Runs INSIDE the send pipeline after the idempotency pre-check —
 * a retry never reaches here. Outcomes:
 *  - unknown or retired template → TemplateNotFound (I10);
 *  - supplied field names ≠ declared binding fields → TemplateFieldMismatch;
 *  - a stored binding outside the R12 allowlist → ValidationFailed (the
 *    template itself is invalid — the same rule UpsertTemplate enforces);
 *  - the rendered message failing the SendMessage door (e.g. body.text not a
 *    non-empty string, a priority binding rendering a non-Priority value) →
 *    ValidationFailed — the rendered send validates as SendMessage, exactly
 *    as the contract rules.
 */
export async function renderTemplateSend(
  store: MessagingStore,
  input: SendFromTemplateInput,
): Promise<RenderedTemplateSend | MessagingError> {
  const found = await store.getTemplate(input.templateId);
  if (found.kind === "error") {
    if (found.error.name === "RecordNotFound") return templateNotFound(input.templateId);
    return storeDependencyError(found.error);
  }
  const template = found.value;
  if (template.retired) return templateNotFound(input.templateId);

  // DEC-15: the supplied fields must match the declared bindings exactly —
  // no missing, no extra.
  const issues: ValidationIssue[] = [];
  const declared = new Set(template.bindings.map((binding) => binding.field));
  for (const name of Object.keys(input.fields)) {
    if (!declared.has(name)) {
      issues.push({ path: `fields.${name}`, message: "not declared by the template's bindings" });
    }
  }
  for (const binding of template.bindings) {
    // DEC-15 is an OWN-key match: `in` would walk the prototype chain, so a
    // binding field named `constructor` or `toString` would look satisfied by
    // an EMPTY fields object (audit F1). Object.hasOwn checks own keys only.
    if (!Object.hasOwn(input.fields, binding.field)) {
      issues.push({ path: `fields.${binding.field}`, message: "required by the template's bindings" });
    }
  }
  if (issues.length > 0) {
    return new MessagingError("TemplateFieldMismatch", {
      message: `supplied fields do not match template ${template.id}'s declared bindings (DEC-15)`,
      retryable: false,
      fields: { templateId: template.id, issues },
    });
  }

  // Render. Every path here has passed isBindablePath (re-checked), so the
  // shape dispatch is total over the allowlist's three forms: literal
  // body.<key>, the body.fields.<name> pattern, and priority.
  const body: Record<string, unknown> = {};
  // Custom fields accumulate in a Map (null-prototype semantics, audit F2):
  // a key can never collide with Object.prototype members, and fromEntries
  // copies with own-key semantics — even a hypothetical `__proto__` key would
  // survive as a visible own key instead of mutating the prototype. (The
  // isBindablePath re-check below rejects those keys outright; this is the
  // second line of defense.) The stored value is a plain object.
  const customFields = new Map<string, unknown>();
  let priority: unknown = input.priority;
  for (const binding of template.bindings) {
    if (!isBindablePath(binding.path)) {
      return validationFailedError([
        {
          path: `bindings.${binding.field}`,
          message: `stored template binding targets non-bindable path ${binding.path} (R12)`,
        },
      ]);
    }
    const value = input.fields[binding.field];
    if (binding.path === "priority") {
      priority = value;
    } else if (binding.path.startsWith("body.fields.")) {
      customFields.set(binding.path.slice("body.fields.".length), value);
    } else {
      // body.text | body.subject | body.format (the remaining allowlist literals).
      body[binding.path.slice("body.".length)] = value;
    }
  }
  if (customFields.size > 0) body["fields"] = Object.fromEntries(customFields);

  // The rendered send crosses the SAME door parser as SendMessage — templates
  // cannot drift from the contract (DEC-15).
  const reparsed = parseSendMessageInput({
    address: input.address,
    body,
    priority,
    clientMessageId: input.clientMessageId,
  });
  if (!reparsed.ok) return reparsed.error;

  return {
    command: reparsed.value,
    templateRef: { templateId: template.id, fields: input.fields },
  };
}

export interface TemplateCommandsDeps {
  store: MessagingStore;
  clock: ClockIds;
}

export function createTemplateCommands(deps: TemplateCommandsDeps) {
  const { store, clock } = deps;

  function requireTemplateWrite(principal: Principal): void {
    if (!principal.grants.includes("template.write")) {
      throw new MessagingError("NotAuthorized", {
        message: "template management requires the template.write grant",
        retryable: false,
        fields: { requiredGrant: "template.write" },
      });
    }
  }

  async function upsertTemplate(
    principal: Principal,
    input: UpsertTemplateInput,
  ): Promise<TemplateUpserted> {
    requireTemplateWrite(principal);
    const issues = bindingIssues(input.bindings);
    if (issues.length > 0) throw validationFailedError(issues);

    for (let attempt = 0; attempt < MAX_REVISION_RETRIES; attempt += 1) {
      let prior: Template | undefined;
      if (input.templateId !== undefined) {
        // Supplying templateId means REVISE (Store-Seam §5 expectedRevision
        // semantics). UpsertTemplate's frozen error list has no TemplateNotFound,
        // so revising an absent template is a ValidationFailed on the input.
        const found = await store.getTemplate(input.templateId);
        if (found.kind === "error") {
          if (found.error.name === "RecordNotFound") {
            throw validationFailedError([
              { path: "templateId", message: `no such template: ${input.templateId} (omit templateId to create)` },
            ]);
          }
          throw storeDependencyError(found.error);
        }
        prior = found.value;
      }
      const template: Template = {
        id: prior?.id ?? clock.newId("template"),
        kind: "template",
        schemaVersion,
        createdAt: prior?.createdAt ?? clock.now(),
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        bindings: input.bindings,
        // I10: retirement is one-way in v1 — a revise never resurrects.
        retired: prior?.retired ?? false,
        revision: (prior?.revision ?? 0) + 1,
      };
      const written = await store.putTemplate(template, prior?.revision);
      if (written.kind === "ok") {
        return { templateId: template.id, revision: written.value.revision };
      }
      if (written.error.name === "RevisionConflict") continue; // re-read and re-decide
      throw storeDependencyError(written.error);
    }
    throw storeDependencyError({
      name: "StoreUnavailable",
      message: "template write kept conflicting after bounded retries",
      retryable: true,
    });
  }

  async function retireTemplate(
    principal: Principal,
    input: RetireTemplateInput,
  ): Promise<Record<string, never>> {
    requireTemplateWrite(principal);
    for (let attempt = 0; attempt < MAX_REVISION_RETRIES; attempt += 1) {
      const found = await store.getTemplate(input.templateId);
      if (found.kind === "error") {
        if (found.error.name === "RecordNotFound") throw templateNotFound(input.templateId);
        throw storeDependencyError(found.error);
      }
      // Idempotent (ClosePresence precedent, R9): already retired IS the
      // desired end state — history is unchanged either way (I10).
      if (found.value.retired) return {};
      const retired = await store.retireTemplate(input.templateId, found.value.revision);
      if (retired.kind === "ok") return {};
      if (retired.error.name === "RevisionConflict") continue;
      if (retired.error.name === "RecordNotFound") throw templateNotFound(input.templateId);
      throw storeDependencyError(retired.error);
    }
    throw storeDependencyError({
      name: "StoreUnavailable",
      message: "template retire kept conflicting after bounded retries",
      retryable: true,
    });
  }

  return { upsertTemplate, retireTemplate };
}

export type TemplateCommands = ReturnType<typeof createTemplateCommands>;
