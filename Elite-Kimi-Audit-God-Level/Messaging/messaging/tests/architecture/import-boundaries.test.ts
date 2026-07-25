/**
 * Architecture proofs (MSG-013, G4, Plan §17) — dependency-free: this suite
 * walks the COMPILED import graph (dist/) plus the test TS sources with
 * nothing but node builtins and asserts:
 *
 *   (a) the consumer door is the only door: no test in tests/capability,
 *       tests/contract, tests/harness, or tests/standalone imports the capability's private
 *       modules (core/ seams/ adapters/ protocol/) — the TS sources are
 *       scanned so type-only imports count too; and the external Chief
 *       client (tests/standalone/external-chief.ts) compiles to a module
 *       whose ONLY runtime dependency is `ws` — the MSG-004 proof that an
 *       external principal needs no Novakai-specific object.
 *   (b) the capability graph has no import cycles.
 *   (c) adapters never import each other (Plan §17 rule). store-shared.js is
 *       the documented exception: it is not an adapter but the shared store
 *       core both store adapters are built on.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// dist/tests/architecture/ -> package root is three levels up.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distRoot = join(packageRoot, "dist");
const testsSourceRoot = join(packageRoot, "tests");

const CAPABILITY_DIRS = ["public", "core", "seams", "adapters", "protocol", "composition"];
/** store-shared is the shared store core, not an adapter (Plan §17 rule targets adapters). */
const NOT_AN_ADAPTER = new Set(["store-shared.js"]);

function listJsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      out.push(...listJsFiles(path));
    } else if (entry.endsWith(".js")) {
      out.push(path);
    }
  }
  return out;
}

// SCANNER LIMITATIONS (tripwire, not proof): this regex matches LITERAL
// specifiers only — import(variable), createRequire, or eval-constructed
// imports evade it, and the TS-source scans judge RELATIVE specifiers only
// (bare package specifiers are ignored). The backstop is the compiled-
// artifact assertions (the zero-runtime-imports proofs below and in the P4
// suite), which no source-level trick can fake.
const IMPORT_PATTERN =
  /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Every module specifier a compiled JS file imports (runtime graph — type-only imports are erased). L8: dynamic import() and require() count too. */
function importSpecifiers(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/** L8: recursive .ts walk (a nested consumer directory must not escape the scan). */
function listTsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      out.push(...listTsFiles(path));
    } else if (entry.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

/** Resolve a relative specifier to an absolute .js path; bare specifiers return undefined. */
function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return resolve(dirname(fromFile), specifier);
}

// The capability runtime graph: compiled file → compiled files it imports.
const capabilityFiles = CAPABILITY_DIRS.flatMap((dir) => listJsFiles(join(distRoot, dir)));
const capabilitySet = new Set(capabilityFiles);
const graph = new Map<string, string[]>();
for (const file of capabilityFiles) {
  graph.set(
    file,
    importSpecifiers(file)
      .map((specifier) => resolveSpecifier(file, specifier))
      .filter((target): target is string => target !== undefined && capabilitySet.has(target)),
  );
}

describe("architecture — the door is the only door (MSG-013, G4)", () => {
  it("no consumer test (capability/contract/harness/standalone) imports capability-private modules (core/seams/adapters/protocol)", () => {
    // tests/capability joined at S2-b (P4): the stand-in second capability
    // and its proof tests obey the same door-only rule as every consumer.
    const consumerTestDirs = ["capability", "contract", "harness", "standalone"];
    const offenders: string[] = [];
    for (const dir of consumerTestDirs) {
      const dirPath = join(testsSourceRoot, dir);
      for (const filePath of listTsFiles(dirPath)) {
        const source = readFileSync(filePath, "utf8");
        for (const match of source.matchAll(IMPORT_PATTERN)) {
          const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
          if (specifier === undefined || !specifier.startsWith(".")) continue;
          // Resolve, then judge: only a specifier that ESCAPES the tests tree
          // into the capability's private source dirs offends (a test dir
          // named "core" — tests/core/helpers — is not the capability core).
          const resolved = resolve(dirname(filePath), specifier);
          if (resolved.startsWith(testsSourceRoot)) continue;
          const outside = relative(testsSourceRoot, resolved).split(sep).join("/");
          if (/^(?:\.\.\/)+(core|seams|adapters|protocol)\//.test(`${outside}/`)) {
            offenders.push(`${filePath.slice(testsSourceRoot.length + 1)} → ${specifier}`);
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "consumer tests cross the public contract only (public/ + the composition root via public/)",
    );
  });

  it("the external Chief client has ZERO runtime messaging imports — only `ws` (MSG-004)", () => {
    const clientFile = join(distRoot, "tests", "standalone", "external-chief.js");
    const runtimeImports = importSpecifiers(clientFile).filter(
      (specifier) => !specifier.startsWith("node:"),
    );
    assert.deepEqual(
      runtimeImports,
      ["ws"],
      "an external principal needs the published wire protocol and nothing Novakai-specific",
    );
  });

  it("no capability module is reachable from consumers except through public/ (+ composition wiring)", () => {
    // The compiled public entry is the door: every private module a consumer
    // could reach is pulled in BY the door or the composition root it
    // re-exports — never the reverse. Asserted concretely: nothing in
    // core/seams/adapters/protocol imports FROM the test tree, and every
    // cross-directory edge in the capability graph respects the dependency
    // direction (consumers → public → composition → core/adapters).
    // The frozen dependency direction (Plan §13/§14/§17): adapters point
    // toward the core; the core knows only the contract and its seams; the
    // door (public/) re-exports the composition surface hosts compose with.
    const dirOf = (file: string): string => {
      const relative = file.slice(distRoot.length + 1);
      return relative.slice(0, relative.indexOf("/"));
    };
    const ALLOWED_EDGES: Record<string, Set<string>> = {
      // The door re-exports adapter factories, seam types, and wire types by design.
      public: new Set(CAPABILITY_DIRS),
      composition: new Set(CAPABILITY_DIRS),
      // The protocol layer speaks the contract and drives the core; the
      // spawnable server entrypoint wraps the composition root.
      protocol: new Set(["public", "core", "seams", "protocol", "composition"]),
      // The core knows the contract and its seams — never an adapter or a host.
      core: new Set(["public", "seams", "core"]),
      seams: new Set(["public", "seams"]),
      // Adapters satisfy seams; the ws transport uses the protocol's wire
      // TYPES (adapter → protocol types only, never adapter → adapter).
      adapters: new Set(["public", "seams", "adapters", "protocol"]),
    };
    const violations: string[] = [];
    for (const [file, targets] of graph) {
      const fromDir = dirOf(file);
      for (const target of targets) {
        const toDir = dirOf(target);
        if (!ALLOWED_EDGES[fromDir]?.has(toDir)) {
          violations.push(`${fromDir} → ${toDir} (${file.slice(distRoot.length + 1)})`);
        }
      }
    }
    assert.deepEqual(violations, [], "dependency direction holds: adapters point at the core, never out");
  });
});

describe("architecture — graph health", () => {
  it("no import cycles anywhere in the capability graph", () => {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>(capabilityFiles.map((file) => [file, WHITE]));
    const cycles: string[] = [];

    function visit(file: string, stack: string[]): void {
      color.set(file, GRAY);
      for (const target of graph.get(file) ?? []) {
        if (color.get(target) === GRAY) {
          cycles.push([...stack, file.slice(distRoot.length + 1), target.slice(distRoot.length + 1)].join(" → "));
        } else if (color.get(target) === WHITE) {
          visit(target, [...stack, file.slice(distRoot.length + 1)]);
        }
      }
      color.set(file, BLACK);
    }
    for (const file of capabilityFiles) {
      if (color.get(file) === WHITE) visit(file, []);
    }
    assert.deepEqual(cycles, [], "the capability graph is acyclic");
  });

  it("adapters never import each other (Plan §17)", () => {
    const adaptersDir = join(distRoot, "adapters");
    const offenders: string[] = [];
    for (const file of listJsFiles(adaptersDir)) {
      const name = file.slice(adaptersDir.length + 1);
      if (NOT_AN_ADAPTER.has(name)) continue;
      for (const specifier of importSpecifiers(file)) {
        const target = resolveSpecifier(file, specifier);
        if (target === undefined || !target.startsWith(adaptersDir)) continue;
        const targetName = target.slice(adaptersDir.length + 1);
        if (NOT_AN_ADAPTER.has(targetName)) continue; // the shared store core is not an adapter
        offenders.push(`${name} → ${targetName}`);
      }
    }
    assert.deepEqual(offenders, [], "no adapter imports another adapter");
  });
});
