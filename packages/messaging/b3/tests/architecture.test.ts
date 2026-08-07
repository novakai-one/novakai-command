/**
 * B3c architecture gates — §8.1, §18.1, §18.2, red gates 25 and 26.
 *
 * Three claims that are about the SHAPE of the code rather than its behaviour,
 * which means no behavioural test can catch them regressing:
 *
 *   1. the B3 production route never imports `store-jsonl`;
 *   2. the Messaging CORE stays free of `@novakai/foundation`;
 *   3. the B3c layer has no import cycle.
 *
 * Each one is a rule someone will break by accident, in a change that
 * otherwise works perfectly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const messagingRoot = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(root: string, ignore: readonly string[] = []): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const relative = path.relative(root, full);
      if (ignore.some((prefix) => relative.startsWith(prefix))) continue;
      found.push(full);
    }
  };
  walk(root);
  return found;
}

const importsOf = (file: string): string[] => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1] ?? "");
};

test("the B3 production route never imports store-jsonl", () => {
  // §8.1: "After trace-complete cutover, the production `store-jsonl` persist
  // hook is disabled; the in-memory adapter remains test-only."
  //
  // Scoped to the B3 route deliberately. Messaging's v1 STANDALONE mode still
  // uses store-jsonl, and must: requirement 1 says Messaging works on its own
  // with no Foundation anywhere near it. What must never happen is the B3
  // Runtime reaching for the old writer.
  const b3Files = sourceFiles(path.join(messagingRoot, "b3"), ["tests"]);
  assert.notEqual(b3Files.length, 0, "the B3c tree was not found");
  for (const file of b3Files) {
    for (const specifier of importsOf(file)) {
      const isJsonlAdapter = specifier.includes("store-jsonl");
      // The cutover module names the legacy FILE as a string; importing its
      // writer is the thing forbidden.
      assert.equal(isJsonlAdapter, false,
        `${path.relative(messagingRoot, file)} imports the legacy store-jsonl writer`);
    }
  }
});

test("the Messaging core and seams stay free of @novakai/foundation", () => {
  // Requirement 1: "I should be able to use messaging by itself independently
  // and it shouldn't matter if the other apps exist or not."
  //
  // B3c gives Messaging a Foundation-backed durability ADAPTER, which is a
  // composition-time choice. If Foundation leaks into the core or the seams,
  // standalone mode stops being real and nobody notices until they try it.
  const coreFiles = [
    ...sourceFiles(path.join(messagingRoot, "core")),
    ...sourceFiles(path.join(messagingRoot, "seams")),
    ...sourceFiles(path.join(messagingRoot, "public")),
  ];
  for (const file of coreFiles) {
    for (const specifier of importsOf(file)) {
      assert.equal(specifier.startsWith("@novakai/foundation"), false,
        `${path.relative(messagingRoot, file)} imports Foundation — `
        + "standalone Messaging is no longer standalone");
    }
  }
});

test("the B3c record contract stays free of @novakai/foundation too", () => {
  // The store seam imports these types, so a Foundation import here would
  // reach the core through the back door the test above is watching the front
  // of.
  const records = path.join(messagingRoot, "b3", "contract", "records.ts");
  for (const specifier of importsOf(records)) {
    assert.equal(specifier.startsWith("@novakai/foundation"), false,
      "b3/contract/records.ts imports Foundation; the store seam imports it, "
      + "so that reaches the core");
  }
});

test("the B3c layer has no import cycle", () => {
  // Red gate 26: "Any new dependency cycle ... is introduced" fails the
  // architecture regardless of score. This caught a real one during the build:
  // the journal projection needed `CommittedFact` from the event bus, and the
  // event bus needed the projection.
  const files = sourceFiles(messagingRoot, ["node_modules", "dist"]);
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const resolved: string[] = [];
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier.replace(/\.js$/u, ""));
      for (const candidate of [`${target}.ts`, path.join(target, "index.ts")]) {
        if (existsFile(candidate)) { resolved.push(candidate); break; }
      }
    }
    edges.set(file, resolved);
  }

  const state = new Map<string, "visiting" | "done">();
  const trail: string[] = [];
  const cycles: string[][] = [];
  const visit = (node: string): void => {
    const seen = state.get(node);
    if (seen === "done") return;
    if (seen === "visiting") {
      cycles.push([...trail.slice(trail.indexOf(node)), node]);
      return;
    }
    state.set(node, "visiting");
    trail.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    trail.pop();
    state.set(node, "done");
  };
  for (const file of files) visit(file);

  assert.deepEqual(
    cycles.map((cycle) => cycle.map((file) => path.relative(messagingRoot, file))),
    [],
    "an import cycle exists inside packages/messaging",
  );
});

function existsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
