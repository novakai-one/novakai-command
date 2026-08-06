// tests/composer.test.ts — SHL-005 / R3-13, the REGISTRY half.
//
// Dispatch moved out. `SlashRegistry.dispatch` used to parse a leading slash and
// return `{kind:'provider'}` for any name a provider had declared — which
// FZ-VIEW-032 forbids in Calm ("routed through a named provider control contract
// or rejected … never guessed"). Parsing now lives in ONE module and is covered
// by `slash-continuity.test.ts`; what is left here is declaration, which is all
// a registry ever should have been.
import { describe, it, expect } from 'vitest';
import { SlashRegistry, SHELL_BUILTINS } from '../contract/composer.js';
import { readSlashInput, SHELL_SLASH_DOORS } from '../contract/slashContinuity.js';

describe('the Shell command registry', () => {
  it('built-in set is exactly the S1 list (no invented commands)', () => {
    expect(SHELL_BUILTINS.map((c) => c.name).sort()).toEqual(
      ['archive', 'new', 'pin', 'speed', 'theme'].sort(),
    );
  });

  it('a provider declaration adds a NAME and nothing else', () => {
    const reg = new SlashRegistry();
    reg.registerProviderCommand({ name: 'compact', description: 'compact the context' });
    expect(reg.declaredNames()).toEqual(['compact']);
    expect(reg.all().map((c) => c.name)).toContain('compact');
    expect(reg.declared()[0].source).toBe('provider');
  });

  it('a declaration is not a route — the same name is still refused in Calm', () => {
    // The whole reason declaration and dispatch are separate files.
    const reg = new SlashRegistry();
    reg.registerProviderCommand({ name: 'compact', description: 'compact the context' });
    const answer = readSlashInput('/compact', {
      surface: 'calm',
      holdsInputLease: false,
      providerDeclared: reg.declaredNames(),
      doors: SHELL_SLASH_DOORS,
    });
    expect(answer.kind).toBe('refused');
  });

  it('the registry itself no longer parses', () => {
    const reg = new SlashRegistry() as unknown as Record<string, unknown>;
    expect(typeof reg.dispatch).toBe('undefined');
    expect(typeof reg.suggest).toBe('undefined');
  });
});
