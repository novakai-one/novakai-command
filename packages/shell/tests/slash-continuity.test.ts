// tests/slash-continuity.test.ts — FZ-VIEW-032, the whole row:
//
//   Raw mode passes provider-native slash commands through unchanged UNDER THE
//   INPUT LEASE; Calm/Message mode is owned by the Shell Novakai command
//   registry; /btw, /side, /plugins keep their existing Novakai meaning; a
//   provider-native command in Calm is either routed through a NAMED provider
//   control contract or rejected with a plain explanation — NEVER GUESSED;
//   Terminal package does not parse slash commands.
//
// Every test below is one clause of that sentence. The two that matter most are
// "unchanged" (byte-for-byte, not trimmed) and "never guessed" (a provider
// DECLARING a name is not a route to run it).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSlashInput,
  slashPalette,
  SHELL_SLASH_DOORS,
  NAMED_PROVIDER_CONTROLS,
  NOVAKAI_RESERVED_NAMES,
  type SlashSituation,
} from '../contract/slashContinuity.js';

const rawLive = (over: Partial<SlashSituation> = {}): SlashSituation => ({
  surface: 'raw',
  holdsInputLease: true,
  providerDeclared: [],
  doors: SHELL_SLASH_DOORS,
  ...over,
});

const calm = (over: Partial<SlashSituation> = {}): SlashSituation => ({
  surface: 'calm',
  holdsInputLease: false,
  providerDeclared: [],
  doors: SHELL_SLASH_DOORS,
  ...over,
});

describe('FZ-VIEW-032 · Raw passes through unchanged, under the lease', () => {
  it('a provider-native command reaches the provider byte-for-byte', () => {
    const input = '/compact   keep the plan  ';
    const a = readSlashInput(input, rawLive({ providerDeclared: ['compact'] }));
    expect(a.kind).toBe('raw-passthrough');
    // "unchanged" is not "trimmed and re-joined". A provider that treats
    // trailing whitespace as an argument boundary must see what was typed.
    if (a.kind === 'raw-passthrough') expect(a.text).toBe(input);
  });

  it('a NOVAKAI name typed in Raw still belongs to the provider', () => {
    // Continuity is decided by the SURFACE, not by the word. Capturing /btw in
    // Raw would silently eat a keystroke the provider was waiting for.
    const a = readSlashInput('/btw look at this', rawLive());
    expect(a.kind).toBe('raw-passthrough');
  });

  it('Raw does not parse at all — plain text takes the same path', () => {
    const a = readSlashInput('ls -la', rawLive());
    expect(a.kind).toBe('raw-passthrough');
  });

  it('the Raw answer carries no parsed name or args', () => {
    // Structural: if a name ever appears here, something in the Shell has begun
    // parsing Raw input, which is the clause this row exists to forbid.
    const a = readSlashInput('/model opus', rawLive({ providerDeclared: ['model'] }));
    expect(Object.keys(a).sort()).toEqual(['kind', 'text']);
  });

  it('without the active input lease nothing is sent, and it says why', () => {
    const a = readSlashInput('/compact', rawLive({ holdsInputLease: false }));
    expect(a.kind).toBe('raw-blocked');
    if (a.kind === 'raw-blocked') {
      expect(a.because.length).toBeGreaterThan(0);
      // §13.4: many attachments may read, exactly one lease generation writes.
      expect(a.because).toContain('no write lease');
      expect(a.because).toContain('nothing was sent');
      // and it claims NOTHING about who has it — an exited session has no rival
      expect(a.because.toLowerCase()).not.toContain('another');
    }
    // and the text is NOT carried anywhere a caller could still send it
    expect(Object.keys(a)).not.toContain('text');
  });
});

describe('FZ-VIEW-032 · Calm is owned by the Shell registry', () => {
  it('plain text is a message, not a command', () => {
    expect(readSlashInput('hello there', calm())).toEqual({ kind: 'message', text: 'hello there' });
  });

  it('a Shell built-in dispatches with its args', () => {
    const a = readSlashInput('/theme dark', calm());
    expect(a).toEqual({ kind: 'novakai', name: 'theme', args: 'dark' });
  });

  it('a provider may not shadow a Shell built-in', () => {
    const a = readSlashInput('/theme dark', calm({ providerDeclared: ['theme'] }));
    expect(a.kind).toBe('novakai');
  });

  it('an unknown word is a typed error with suggestions, never silence', () => {
    const a = readSlashInput('/thm', calm());
    expect(a.kind).toBe('unknown');
    if (a.kind === 'unknown') {
      expect(a.error.code).toBe('UnknownCommand');
      expect(a.error.details.suggestions).toContain('/theme');
    }
  });
});

describe('FZ-VIEW-032 · /btw, /side and /plugins keep their Novakai meaning', () => {
  it.each(NOVAKAI_RESERVED_NAMES)('a provider cannot capture /%s', (name) => {
    // The hazard this pins: a provider declares /btw, and the word Chris has
    // always used for a Novakai side note starts going to the model instead.
    const a = readSlashInput(`/${name} something`, calm({ providerDeclared: [name] }));
    expect(a.kind).not.toBe('provider-control');
    expect(a.kind).not.toBe('unknown');
  });

  it.each(NOVAKAI_RESERVED_NAMES)('/%s is refused as a Novakai name this build has no operation for', (name) => {
    const a = readSlashInput(`/${name}`, calm());
    expect(a.kind).toBe('refused');
    if (a.kind === 'refused') expect(a.because).toContain('Novakai');
  });

  it('a host that implements one runs it as a Novakai command', () => {
    // The second-host case: nothing about the rule changes when the door opens.
    const a = readSlashInput('/btw check the diff', calm({
      doors: { ...SHELL_SLASH_DOORS, reservedNovakaiCommands: ['btw'] },
    }));
    expect(a).toEqual({ kind: 'novakai', name: 'btw', args: 'check the diff' });
  });
});

describe('FZ-VIEW-032 · a provider command in Calm is routed by NAME or refused', () => {
  it('the named control set is exactly AgentControl["name"]', () => {
    // FZ-VIEW-029/030 close this set. A fourth name here would be an invented
    // control, which is the guess in its purest form.
    expect([...NAMED_PROVIDER_CONTROLS].sort()).toEqual(['effort', 'model', 'provider-setting']);
  });

  it('B3e has no control door, so /model is refused and names the real route', () => {
    const a = readSlashInput('/model opus', calm({ providerDeclared: ['model'] }));
    expect(a.kind).toBe('refused');
    if (a.kind === 'refused') {
      // FZ-CLI-022 is Lane A's surface. Naming it is the whole point of a
      // refusal: a limit with no next step is a dead end.
      expect(a.instead).toContain('nvk agent control');
    }
  });

  it('a declared provider command outside the named set is never guessed', () => {
    const a = readSlashInput('/compact now', calm({ providerDeclared: ['compact'] }));
    expect(a.kind).toBe('refused');
    if (a.kind === 'refused') {
      expect(a.because).toContain('/compact');
      expect(a.instead).toMatch(/Raw/);
    }
  });

  it('with a control door, a named control routes through the public contract', () => {
    const a = readSlashInput('/effort high', calm({
      providerDeclared: ['effort'],
      doors: { ...SHELL_SLASH_DOORS, providerControl: true },
    }));
    expect(a).toEqual({
      kind: 'provider-control',
      control: { name: 'effort', value: 'high' },
      route: 'nvk-agent-control',
    });
  });

  it('a named control with no value is refused, never sent with a guessed one', () => {
    const a = readSlashInput('/model', calm({
      providerDeclared: ['model'],
      doors: { ...SHELL_SLASH_DOORS, providerControl: true },
    }));
    expect(a.kind).toBe('refused');
    if (a.kind === 'refused') expect(a.because.toLowerCase()).toContain('value');
  });

  it('an open door does not widen the named set', () => {
    const a = readSlashInput('/compact', calm({
      providerDeclared: ['compact'],
      doors: { ...SHELL_SLASH_DOORS, providerControl: true },
    }));
    expect(a.kind).toBe('refused');
  });

  it('a control name the provider never declared is still not invented', () => {
    // No declaration, no capability report: Novakai has not been told this
    // provider understands it. Sending it anyway is a guess with a nice name.
    const a = readSlashInput('/effort high', calm({
      doors: { ...SHELL_SLASH_DOORS, providerControl: true },
    }));
    expect(a.kind).toBe('refused');
  });
});

// Walks a source tree. Declared at module scope, ABOVE the describe that uses
// it: a hoisted call reading a `const` declared below is how seat 6 blanked a
// whole preview page with every assertion still green.
const sourceFiles = (dir: string, exts: readonly string[]): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, exts));
    else if (exts.some((e) => full.endsWith(e)) && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
};

const shellRoot = fileURLToPath(new URL('..', import.meta.url));
const terminalRoot = fileURLToPath(new URL('../../terminal', import.meta.url));
const PARSES_LEADING_SLASH = /startsWith\(\s*['"]\/['"]\s*\)/;

describe('FZ-VIEW-032 · the palette offers only what can run', () => {
  it('a named control is NOT offered while the door is shut', () => {
    // Read off the first screenshot of tools/slash-preview.html: /model was in
    // the list on a host that can only refuse it.
    const names = slashPalette('', calm({ providerDeclared: ['model'] }), [
      { name: 'model', description: 'switch model', source: 'provider' },
    ]).map((c) => c.name);
    expect(names).not.toContain('model');
  });

  it('it IS offered once the door is open', () => {
    const names = slashPalette('', calm({
      providerDeclared: ['model'],
      doors: { ...SHELL_SLASH_DOORS, providerControl: true },
    }), [{ name: 'model', description: 'switch model', source: 'provider' }]).map((c) => c.name);
    expect(names).toContain('model');
  });

  it('a declared command outside the named set is never offered', () => {
    const names = slashPalette('', calm({
      providerDeclared: ['compact'],
      doors: { ...SHELL_SLASH_DOORS, providerControl: true },
    }), [{ name: 'compact', description: 'compact', source: 'provider' }]).map((c) => c.name);
    expect(names).not.toContain('compact');
  });

  it('Raw offers nothing at all', () => {
    expect(slashPalette('', rawLive())).toEqual([]);
  });

  it('a reserved name appears only where it can run', () => {
    expect(slashPalette('b', calm()).map((c) => c.name)).not.toContain('btw');
    expect(slashPalette('b', calm({
      doors: { ...SHELL_SLASH_DOORS, reservedNovakaiCommands: ['btw'] },
    })).map((c) => c.name)).toContain('btw');
  });
});

describe('FZ-VIEW-032 · the Terminal package does not parse slash commands', () => {
  it('no file in packages/terminal splits input on a leading slash', () => {
    const offenders = sourceFiles(terminalRoot, ['.ts']).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return PARSES_LEADING_SLASH.test(src) || /slashCommand/i.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('no file in packages/terminal knows the reserved Novakai names', () => {
    const offenders = sourceFiles(terminalRoot, ['.ts']).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return NOVAKAI_RESERVED_NAMES.some((n) => src.includes(`/${n} `) || src.includes(`'/${n}'`));
    });
    expect(offenders).toEqual([]);
  });

  it('the Shell parses a leading slash in exactly one module', () => {
    // "Never a second registry" made structural: a screen that grows its own
    // parser is how the two surfaces start disagreeing about the same keystroke.
    const parsers = ['contract', 'ui', 'app', 'cli']
      .flatMap((d) => sourceFiles(join(shellRoot, d), ['.ts', '.tsx']))
      .filter((f) => PARSES_LEADING_SLASH.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(shellRoot.length));
    expect(parsers).toEqual(['contract/slashContinuity.ts']);
  });
});
