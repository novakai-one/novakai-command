#!/usr/bin/env node
// check-map-drift.mjs — law #3 guard.
// Verifies that every enumeration Messaging-Map.html copies from the single
// source of truth (contract/messaging-contract.json) actually matches it.
// The map's prose is curated; its enumerations are NOT trusted to hand-copying.
//
// Usage:  node contract/check-map-drift.mjs        (from the Messaging/ directory)
// Exit 0 = no drift. Exit 1 = drift found (prints every mismatch).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const contract = JSON.parse(readFileSync(join(here, "messaging-contract.json"), "utf8"));
const mapSrc = readFileSync(join(root, "Messaging-Map.html"), "utf8");

const script = mapSrc.match(/<script>([\s\S]*)<\/script>/)[1];
const modules = eval(script.match(/const MODULES = (\[[\s\S]*?\n\]);/)[1]);
const traces = eval(script.match(/const TRACES = (\[[\s\S]*?\n\]);/)[1]);

const failures = [];
const check = (label, actual, expected) => {
  const a = [...actual].sort().join(" · ");
  const e = [...expected].sort().join(" · ");
  if (a !== e) failures.push(`${label}\n  map:      ${a}\n  contract: ${e}`);
};
const split = s => s.split(" · ").map(x => x.trim()).filter(Boolean);
const mod = id => modules.find(m => m.id === id);

// 1. The four catalogues — exact set equality (sorted comparison).
check("errors catalogue", split(mod("errors").exposes), contract.errors.map(e => e.name));
check("command names", split(mod("commands").exposes), contract.commands.map(c => c.name));
check("query names", split(mod("queries").exposes), contract.queries.map(q => q.name));
check("event names", split(mod("events").exposes), contract.events.map(e => e.name));

// 2. The subscription operation exists on the map and names Subscribe.
const subs = mod("subscriptions");
if (!subs) failures.push("map has no `subscriptions` module");
else if (!subs.exposes.includes("Subscribe")) failures.push("subscriptions module does not expose Subscribe");

// 3. Store seam surface — the load-bearing operations must all be present.
const storeOps = ["commitAcceptance", "transitionDelivery", "getMessages", "getInbox", "scanJournal", "listPendingAcceptances", "markEffectsSettled", "findAcceptance"];
for (const op of storeOps) {
  if (!mod("store").exposes.includes(op)) failures.push(`store seam exposes omits ${op}`);
}

// 4. Every trace step references a real module; module ids are unique; deps resolve.
const ids = modules.map(m => m.id);
if (new Set(ids).size !== ids.length) failures.push("duplicate module ids");
for (const m of modules) for (const d of m.dependsOn) {
  if (!ids.includes(d)) failures.push(`${m.id} depends on missing module ${d}`);
}
for (const t of traces) for (const s of t.steps) {
  if (!ids.includes(s.mod)) failures.push(`trace ${t.id} references missing module ${s.mod}`);
}

// 5. MSG-023 trace exists and is sliced S3 (binding amendment A2).
const t4 = traces.find(t => t.id === "t4");
if (!t4) failures.push("no t4 (W4 / MSG-023) trace");
else if (t4.slice !== "S3") failures.push(`t4 slice is ${t4.slice}, must be S3 (A2)`);

if (failures.length) {
  console.error(`DRIFT DETECTED — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error("• " + f);
  process.exit(1);
}
console.log(`NO DRIFT — map enumerations match the contract source (${modules.length} modules, ${traces.length} traces checked).`);
