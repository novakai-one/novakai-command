// tests/composer.test.ts — SHL-005 / R3-13: dispatch order shell built-ins →
// provider-declared → typed UnknownCommand (never silent).
import { describe, it, expect } from 'vitest';
import { SlashRegistry, SHELL_BUILTINS } from '../contract/composer.js';

describe('slash dispatch order', () => {
  it('plain text is a message, not a command', () => {
    const r = new SlashRegistry().dispatch('hello there');
    expect(r).toEqual({ kind: 'message', text: 'hello there' });
  });

  it('shell built-ins dispatch first', () => {
    const reg = new SlashRegistry();
    // a provider may not shadow a built-in: built-ins win the name
    reg.registerProviderCommand({ name: 'new', description: 'provider new' });
    const r = reg.dispatch('/new');
    expect(r.kind).toBe('builtin');
    if (r.kind === 'builtin') expect(r.name).toBe('new');
  });

  it('provider-declared commands dispatch second, with args', () => {
    const reg = new SlashRegistry();
    reg.registerProviderCommand({ name: 'btw', description: 'side note' });
    const r = reg.dispatch('/btw check the diff');
    expect(r).toEqual({ kind: 'provider', name: 'btw', args: 'check the diff' });
  });

  it('unknown commands are typed UnknownCommand errors with suggestions', () => {
    const reg = new SlashRegistry();
    const r = reg.dispatch('/thm');
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.error.code).toBe('UnknownCommand');
      expect(r.error.retryable).toBe(false);
      expect(r.error.details.input).toBe('/thm');
      expect(r.error.details.suggestions).toContain('/theme');
    }
  });

  it('completely unknown input yields an empty suggestion list, still typed', () => {
    const r = new SlashRegistry().dispatch('/zzzz');
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.details.suggestions).toEqual([]);
  });

  it('the palette suggests by prefix over built-ins + provider commands', () => {
    const reg = new SlashRegistry();
    reg.registerProviderCommand({ name: 'side', description: 'side thread' });
    const names = reg.suggest('s').map((c) => c.name);
    expect(names).toContain('speed');
    expect(names).toContain('side');
  });

  it('built-in set is exactly the S1 list (no invented commands)', () => {
    expect(SHELL_BUILTINS.map((c) => c.name).sort()).toEqual(
      ['archive', 'new', 'pin', 'speed', 'theme'].sort(),
    );
  });
});
