/** TF-00 architecture proof: one consumer doorway and corrected dependency direction. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = existsSync(join(here, "..", "..", "contract", "messaging-contract.json"))
  ? join(here, "..", "..")
  : join(here, "..", "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");
const distRoot = join(packageRoot, "dist");
const sourceRoot = packageRoot;
const testsSourceRoot = join(packageRoot, "tests");
const CAPABILITY_DIRS = ["contract", "core", "adapters"];
const IMPORT_PATTERN =
  /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

function listFiles(root: string, suffix: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) out.push(...listFiles(path, suffix));
    else if (entry.endsWith(suffix)) out.push(path);
  }
  return out;
}

function importSpecifiers(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  return specifier.startsWith(".") ? resolve(dirname(fromFile), specifier) : undefined;
}

const capabilityFiles = CAPABILITY_DIRS.flatMap((dir) => listFiles(join(distRoot, dir), ".js"));
const capabilitySet = new Set(capabilityFiles);
const graph = new Map<string, string[]>();
for (const file of capabilityFiles) {
  graph.set(file, importSpecifiers(file)
    .map((specifier) => resolveSpecifier(file, specifier))
    .filter((target): target is string => target !== undefined && capabilitySet.has(target)));
}

describe("architecture — one Messaging doorway", () => {
  it("outside consumers import only contract/index.ts", () => {
    const offenders: string[] = [];
    for (const file of listFiles(join(repoRoot, "packages"), ".ts")) {
      if (file.startsWith(packageRoot + sep)) continue;
      for (const specifier of importSpecifiers(file)) {
        if (specifier === "@novakai/messaging") continue;
        const target = resolveSpecifier(file, specifier);
        if (target === undefined || !target.startsWith(packageRoot + sep)) continue;
        if (target.endsWith(join("contract", "index.js"))) continue;
        offenders.push(`${relative(repoRoot, file)} → ${specifier}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("Messaging tests import owning modules directly, never the host barrel", () => {
    const offenders: string[] = [];
    for (const file of listFiles(testsSourceRoot, ".ts")) {
      for (const specifier of importSpecifiers(file)) {
        if (!specifier.startsWith(".")) continue;
        const target = resolveSpecifier(file, specifier);
        if (target !== undefined && target.endsWith(join("contract", "index.js"))) {
          offenders.push(`${relative(testsSourceRoot, file)} → ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("core imports declaration-only contract modules, never behavior or wiring", () => {
    const allowed = new Set([
      "types", "errors", "records", "events", "subscriptions",
      "commands", "queries", "outcome", "runtime",
      "communications", "conversations", "agent-delivery-marker",
      "conversation-id", "transcript-line-id", "correlation", "provider-name",
    ]);
    const offenders: string[] = [];
    for (const file of listFiles(join(sourceRoot, "core"), ".ts")) {
      for (const specifier of importSpecifiers(file)) {
        if (specifier.includes("/contract/ports/")) continue;
        const match = /\/contract\/([^/]+)\.js$/.exec(specifier);
        if (match && !allowed.has(match[1] ?? "")) {
          offenders.push(`${relative(sourceRoot, file)} → ${specifier}`);
        }
        if (specifier.includes("/contract/api.js")
          || specifier.includes("/contract/compose")
          || specifier.includes("/contract/index.js")) {
          offenders.push(`${relative(sourceRoot, file)} → ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("superseded top-level boundary folders are absent", () => {
    for (const dir of ["public", "seams", "composition", "protocol", "api"]) {
      assert.equal(existsSync(join(packageRoot, dir)), false, `${dir}/ must be absent`);
    }
  });
});

describe("architecture — graph health", () => {
  it("has no import cycles", () => {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycles: string[] = [];
    function visit(file: string, stack: string[]): void {
      visiting.add(file);
      for (const target of graph.get(file) ?? []) {
        if (visiting.has(target)) cycles.push([...stack, file, target].join(" → "));
        else if (!visited.has(target)) visit(target, [...stack, file]);
      }
      visiting.delete(file);
      visited.add(file);
    }
    for (const file of capabilityFiles) if (!visited.has(file)) visit(file, []);
    assert.deepEqual(cycles, []);
  });

  it("TF-00 structural modules stay within the 300-line ceiling", () => {
    const serverRoot = join(repoRoot, "packages", "server", "core");
    const shellRoot = join(repoRoot, "packages", "shell", "ui", "screens", "messaging");
    const files = [
      ...listFiles(join(sourceRoot, "contract"), ".ts"),
      join(serverRoot, "boot.ts"),
      ...listFiles(join(serverRoot, "boot"), ".ts"),
      join(serverRoot, "methods.ts"),
      ...listFiles(join(serverRoot, "methods"), ".ts"),
      join(shellRoot, "useBenchData.ts"),
      join(shellRoot, "records.ts"),
      join(shellRoot, "unread.ts"),
      join(shellRoot, "designData.ts"),
    ];
    const oversized = files.flatMap((file) => {
      const lines = readFileSync(file, "utf8").split(/\r?\n/u).length;
      return lines > 300 ? [`${relative(repoRoot, file)}: ${lines}`] : [];
    });
    assert.deepEqual(oversized, []);
  });

  it("TF-01 production modules stay within the 300-line ceiling", () => {
    const files = [
      ...listFiles(join(sourceRoot, "core", "ingestion"), ".ts"),
      join(sourceRoot, "core", "event-bus.ts"),
      ...listFiles(join(sourceRoot, "adapters", "provider-transcripts"), ".ts"),
      ...listFiles(join(sourceRoot, "adapters", "stores"), ".ts"),
    ];
    const oversized = files.flatMap((file) => {
      const lines = readFileSync(file, "utf8").split(/\r?\n/u).length;
      return lines > 300 ? [`${relative(repoRoot, file)}: ${lines}`] : [];
    });
    assert.deepEqual(oversized, []);
  });

  it("the production Server reaches provider transcripts only through Messaging", () => {
    const offenders: string[] = [];
    const serverCore = join(repoRoot, "packages", "server", "core");
    for (const file of listFiles(serverCore, ".ts")) {
      for (const specifier of importSpecifiers(file)) {
        if (/transcript\/(?:adapters|core|b3\/adapters)/u.test(specifier)) {
          offenders.push(`${relative(repoRoot, file)} → ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("retired transcript authorities are absent", () => {
    const retired = [
      join(repoRoot, "packages", "transcript", "package.json"),
      join(packageRoot, "b3", "contract", "index.ts"),
      join(repoRoot, "packages", "server", "core", "b3", "messaging-composition.ts"),
      join(repoRoot, "packages", "server", "core", "b3", "stored-transcript-source.ts"),
      join(repoRoot, "packages", "server", "core", "b3", "b3c-ports.ts"),
    ];
    assert.deepEqual(retired.filter(existsSync), []);
  });

  it("adapter families do not import other adapter families", () => {
    const adapterRoot = join(distRoot, "adapters");
    const allowedShared = new Set<string>();
    const offenders: string[] = [];
    for (const file of listFiles(adapterRoot, ".js")) {
      const from = relative(adapterRoot, file).split(sep).join("/");
      if (allowedShared.has(from)) continue;
      for (const specifier of importSpecifiers(file)) {
        const target = resolveSpecifier(file, specifier);
        if (target === undefined || !target.startsWith(adapterRoot)) continue;
        const to = relative(adapterRoot, target).split(sep).join("/");
        const fromFamily = from.includes("/") ? from.split("/")[0] : from;
        const toFamily = to.includes("/") ? to.split("/")[0] : to;
        if (fromFamily === toFamily) continue;
        if (!allowedShared.has(to)) offenders.push(`${from} → ${to}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('production composition never imports the retired JSONL writer', () => {
    const production = [
      ...listFiles(join(sourceRoot, 'contract'), '.ts'),
      ...listFiles(join(sourceRoot, 'cli'), '.ts'),
    ];
    const offenders = production.filter((file) =>
      readFileSync(file, 'utf8').includes('openJsonlStore'))
      .map((file) => relative(repoRoot, file));
    assert.deepEqual(offenders, []);
  });
});
