#!/usr/bin/env node
/**
 * generate-ts.mjs — law #3 codegen for the Novakai Messaging capability.
 *
 * Reads ../contract/messaging-contract.json (THE single machine-readable source)
 * and emits public/contract/generated.ts. Every enumeration, constant, branded
 * ID, name union, and the R5 delivery state machine in TypeScript derives from
 * this file only. Hand-written code MUST import from generated.ts and never
 * re-type a contract literal.
 *
 * Usage:
 *   node tools/generate-ts.mjs           regenerate public/contract/generated.ts
 *   node tools/generate-ts.mjs --check   exit 1 if the checked-in file is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const contractUrl = new URL("../../contract/messaging-contract.json", import.meta.url);
const outUrl = new URL("../public/contract/generated.ts", import.meta.url);

const sourceText = readFileSync(contractUrl, "utf8");
const contract = JSON.parse(sourceText);
const sourceHash = createHash("sha256").update(sourceText).digest("hex").slice(0, 16);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pascal(segment) {
  return String(segment)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function camel(segment) {
  const p = pascal(segment);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

// ---------------------------------------------------------------------------
// 1. Collect string enums and string consts from $defs and event payloads.
//    Name = PascalCase of the last two path segments; collisions across
//    different value sets are a hard codegen error (never silent drift).
// ---------------------------------------------------------------------------

/** Explicit names where the default path-derived name is wrong or collides. */
const NAME_OVERRIDES = new Map([
  ["Thread.threadKind", "ThreadKind"],
  ["Thread.kind", "ThreadRecordKind"],
  ["SubscriptionMessage.Started.kind", "SubscriptionStartedKind"],
  ["SubscriptionMessage.Event.kind", "SubscriptionEventFrameKind"],
  ["SubscriptionMessage.Ended.kind", "SubscriptionEndedKind"],
  ["SubscriptionMessage.Ended.reason", "SubscriptionEndedReason"],
  ["RecipientSnapshot.blocked.reason", "BlockedReason"],
]);

/** @type {Map<string, { values: string[], path: string, isConst: boolean }>} */
const literals = new Map();

function registerLiteral(path, values, isConst) {
  const key = path.join(".");
  const name =
    NAME_OVERRIDES.get(key) ??
    pascal(path.slice(-2).join(" "));
  if (!name) throw new Error(`cannot name literal at ${key}`);
  const existing = literals.get(name);
  if (existing) {
    const same =
      existing.values.length === values.length &&
      existing.values.every((v, i) => v === values[i]);
    if (!same) {
      throw new Error(
        `literal name collision: ${name} at ${key} (${values}) vs ${existing.path} (${existing.values}) — add a NAME_OVERRIDES entry`,
      );
    }
    return;
  }
  literals.set(name, { values: [...values], path: key, isConst });
}

function walk(node, path) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((v) => typeof v === "string")) {
    registerLiteral(path, node.enum, false);
  }
  if (typeof node.const === "string") {
    registerLiteral(path, [node.const], true);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "enum" || key === "const") continue;
    if (key === "properties" && value && typeof value === "object") {
      for (const [propName, propValue] of Object.entries(value)) {
        walk(propValue, [...path, propName]);
      }
    } else if (key === "items") {
      walk(value, path); // items inherit the property's path for naming
    } else if ((key === "oneOf" || key === "anyOf") && Array.isArray(value)) {
      value.forEach((variant, i) => {
        const kindConst =
          variant && typeof variant === "object" && variant.properties && variant.properties.kind
            ? variant.properties.kind.const
            : undefined;
        walk(variant, [...path, typeof kindConst === "string" ? pascal(kindConst) : `Variant${i}`]);
      });
    } else if (key === "$defs" && value && typeof value === "object") {
      for (const [defName, defValue] of Object.entries(value)) {
        walk(defValue, [defName]);
      }
    }
    // all other keys (type, description, required, …) are not recursed
  }
}

walk({ $defs: contract.$defs }, []);
for (const event of contract.events ?? []) {
  if (event.payload) walk(event.payload, [event.name]);
}

// ---------------------------------------------------------------------------
// 2. Branded identity types. Any $def that is a patterned/formatted string or
//    the integer Sequence becomes a brand. Mintable ID kinds derive from the
//    pattern prefixes (Messaging-Seams.md §5.1: person_ is minted by the
//    Identity authority, never here — excluded explicitly).
// ---------------------------------------------------------------------------

const NON_MINTED = new Set(["PersonId"]); // Messaging-Seams §5.1

/** @type {{ name: string, base: "string" | "number", pattern?: string }[]} */
const idDefs = [];
/** @type {Map<string, string>} mintable kind -> id def name */
const mintable = new Map();

const PREFIX_RE = /^\^(?:\(([A-Za-z0-9|]+)\)|([A-Za-z0-9]+))_/;

for (const [name, def] of Object.entries(contract.$defs)) {
  if (def && typeof def === "object" && def.type === "integer" && name === "Sequence") {
    idDefs.push({ name, base: "number" });
    continue;
  }
  if (!def || typeof def !== "object" || def.type !== "string") continue;
  const isIdentity =
    typeof def.pattern === "string" || typeof def.format === "string" || typeof def.minLength === "number";
  if (!isIdentity) continue;
  idDefs.push({ name, base: "string", pattern: def.pattern });
  if (NON_MINTED.has(name) || typeof def.pattern !== "string") continue;
  const match = PREFIX_RE.exec(def.pattern);
  if (!match) continue;
  const alternatives = (match[1] ?? match[2]).split("|");
  for (const alt of alternatives) {
    const base = name.toLowerCase().replace(/id$/, "");
    // Alternation patterns (PolicyId: contactpolicy|dndpolicy) mint per-alternative;
    // single-prefix patterns must match their def name (excludes Cursor's "s_").
    if (alternatives.length === 1 && alt !== base) continue;
    mintable.set(alt, name);
  }
}

// ---------------------------------------------------------------------------
// 3. Name unions from the operation/event/error catalogues.
// ---------------------------------------------------------------------------

const commandNames = (contract.commands ?? []).map((c) => c.name);
const queryNames = (contract.queries ?? []).map((q) => q.name);
const eventNames = (contract.events ?? []).map((e) => e.name);
const subscriptionNames = (contract.subscriptions ?? []).map((s) => s.name);
const errors = contract.errors ?? [];

// ---------------------------------------------------------------------------
// 4. Delivery state machine (R5) as a typed transition table.
// ---------------------------------------------------------------------------

const machine = contract.stateMachines.delivery;
const triggers = [...new Set(machine.transitions.map((t) => t.trigger))];

// ---------------------------------------------------------------------------
// 5. Emit.
// ---------------------------------------------------------------------------

const lines = [];
const out = (s = "") => lines.push(s);

out(`// ---------------------------------------------------------------------------`);
out(`// GENERATED FILE — DO NOT EDIT.`);
out(`// Source: contract/messaging-contract.json (law #3 single source of truth).`);
out(`// contractVersion ${contract.contractVersion} · schemaVersion ${contract.schemaVersion} · sha256:${sourceHash}`);
out(`// Regenerate: npm run generate`);
out(`// ---------------------------------------------------------------------------`);
out();
out(`declare const brand: unique symbol;`);
out(`type Brand<Name extends string> = { readonly [brand]: Name };`);
out();

out(`// --- versions & constants ------------------------------------------------`);
out(`export const contractVersion = ${JSON.stringify(contract.contractVersion)} as const;`);
out(`export const schemaVersion = ${JSON.stringify(contract.schemaVersion)} as const;`);
out(`export const constants = ${JSON.stringify(contract.constants, null, 2)} as const;`);
out(`export const templateBindablePaths = ${JSON.stringify(contract.templateBindablePaths, null, 2)} as const;`);
out();

out(`// --- branded identities ----------------------------------------------------`);
for (const def of idDefs) {
  const base = def.base === "number" ? "number" : "string";
  out(`export type ${def.name} = ${base} & Brand<${JSON.stringify(def.name)}>;`);
}
out();

out(`// --- id patterns (runtime reference for adapters/validators) ---------------`);
out(`export const idPatterns = {`);
for (const def of idDefs) {
  if (def.pattern) out(`  ${def.name}: ${JSON.stringify(def.pattern)},`);
}
out(`} as const;`);
out();

out(`// --- mintable id kinds (Messaging-Seams §5.1) -------------------------------`);
out(`export const idPrefixes = {`);
for (const kind of [...mintable.keys()].sort()) {
  out(`  ${JSON.stringify(kind)}: ${JSON.stringify(kind + "_")},`);
}
out(`} as const;`);
out(`export type IdKind = keyof typeof idPrefixes;`);
out(`export interface IdTypeMap {`);
for (const kind of [...mintable.keys()].sort()) {
  out(`  readonly ${JSON.stringify(kind)}: ${mintable.get(kind)};`);
}
out(`}`);
out();

out(`// --- enumerations & literal consts (collected from the contract source) -----`);
for (const [name, { values, path, isConst }] of [...literals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const varName = camel(name) + (isConst ? "Value" : "Values");
  out(`// source path: ${path}`);
  out(`export const ${varName} = ${JSON.stringify(values)} as const;`);
  out(`export type ${name} = (typeof ${varName})[number];`);
}
out();

out(`// --- operation / event / error name catalogues -----------------------------`);
const emitNameUnion = (varName, typeName, names) => {
  out(`export const ${varName} = ${JSON.stringify(names)} as const;`);
  out(`export type ${typeName} = (typeof ${varName})[number];`);
};
emitNameUnion("commandNames", "CommandName", commandNames);
emitNameUnion("queryNames", "QueryName", queryNames);
emitNameUnion("eventNames", "EventName", eventNames);
emitNameUnion("subscriptionNames", "SubscriptionName", subscriptionNames);
out();

out(`// --- error catalogue (13 errors; RateLimited is forward-reserved) -----------`);
out(`export const errorCatalogue = [`);
for (const err of errors) {
  out(
    `  { name: ${JSON.stringify(err.name)}, retryable: ${err.retryable === true}, reserved: ${err.reserved === true} },`,
  );
}
out(`] as const;`);
out(`export type ErrorName = (typeof errorCatalogue)[number]["name"];`);
out();
out(`/**`);
out(` * The public error type. One umbrella class; the name discriminates.`);
out(` * Field shapes per error are the *Fields interfaces in ./errors.ts.`);
out(` */`);
out(`export class MessagingError extends Error {`);
out(`  override readonly name: ErrorName;`);
out(`  readonly retryable: boolean;`);
out(`  readonly fields: Record<string, unknown>;`);
out(`  constructor(`);
out(`    name: ErrorName,`);
out(`    options?: { message?: string; retryable?: boolean; fields?: Record<string, unknown> },`);
out(`  ) {`);
out(`    super(options?.message ?? name);`);
out(`    this.name = name;`);
out(`    const catalogueEntry = errorCatalogue.find((entry) => entry.name === name);`);
out(`    this.retryable = options?.retryable ?? catalogueEntry?.retryable ?? false;`);
out(`    this.fields = options?.fields ?? {};`);
out(`  }`);
out(`}`);
out();

out(`// --- R5 delivery state machine ---------------------------------------------`);
out(`export const deliveryTriggerValues = ${JSON.stringify(triggers)} as const;`);
out(`export type DeliveryTrigger = (typeof deliveryTriggerValues)[number];`);
out(`export interface DeliveryTransition {`);
out(`  readonly from: DeliveryState;`);
out(`  readonly to: DeliveryState;`);
out(`  readonly trigger: DeliveryTrigger;`);
out(`  readonly reason: DeliveryStateReason;`);
out(`}`);
out(`export const deliveryStateMachine: {`);
out(`  readonly initial: DeliveryState;`);
out(`  readonly terminal: readonly DeliveryState[];`);
out(`  readonly transitions: readonly DeliveryTransition[];`);
out(`} = {`);
out(`  initial: ${JSON.stringify(machine.initial)},`);
out(`  terminal: ${JSON.stringify(machine.terminal)},`);
out(`  transitions: [`);
for (const t of machine.transitions) {
  out(
    `    { from: ${JSON.stringify(t.from)}, to: ${JSON.stringify(t.to)}, trigger: ${JSON.stringify(t.trigger)}, reason: ${JSON.stringify(t.reason)} },`,
  );
}
out(`  ],`);
out(`};`);
out();

out(`// --- cursor codec (Store-Seam §3: opaque "s_<n>" wrapping the sequence) -----`);
out(`export function cursorFor(sequence: Sequence): Cursor {`);
out(`  return \`s_\${sequence}\` as Cursor;`);
out(`}`);
out();

const text = lines.join("\n");

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outUrl, "utf8");
  } catch {
    // missing entirely counts as stale
  }
  if (current !== text) {
    console.error("generated.ts is STALE — run: npm run generate");
    process.exit(1);
  }
  console.log("generated.ts is up to date.");
} else {
  writeFileSync(outUrl, text);
  console.log(`wrote ${outUrl.pathname} (${literals.size} literal types, ${idDefs.length} branded ids, sha256:${sourceHash})`);
}
