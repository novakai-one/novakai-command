// Finding 5 (NVK-KIMI-021 SEVERE): the terminal tab called listTerminals() —
// every live session on the machine — and adopted value[0]. It ignored the
// working directory it was asked for and it ignored who owned the session, so
// opening the Terminal tab could attach to, take the input lease on, and type
// into a session belonging to an agent run or another process.
//
// Red gate 3 says the identity types are not interchangeable; that is only true
// if the code treats them differently. §24.5 says launch origin is never
// inferred from current attachment — and it is certainly not ignored.
import { describe, it, expect } from 'vitest';
import { chooseAdoptable, type TerminalTabView } from '../contract/terminalServices.js';

const HOME = '/Users/chris/work';

function view(overrides: Partial<TerminalTabView> = {}): TerminalTabView {
  return {
    terminalSessionId: 'terminal_00000000-0000-7000-8000-000000000001',
    status: 'live',
    owner: { kind: 'plain-shell', label: 'novakai-shell' },
    workingDirectory: HOME,
    attachedControllerCount: 0,
    holdsInputLease: false,
    replay: { earliestSequence: 0, latestSequence: 0 },
    ...overrides,
  };
}

describe('which terminal a tab may adopt', () => {
  it('adopts the shell it opened before, in the directory it was asked for', () => {
    const mine = view({ terminalSessionId: 'terminal_mine' });
    expect(chooseAdoptable([mine], HOME, 'novakai-shell')?.terminalSessionId)
      .toBe('terminal_mine');
  });

  it('never adopts a session owned by an agent run', () => {
    const agent = view({
      terminalSessionId: 'terminal_agent',
      owner: { kind: 'agent-run', label: 'agentRun_7' },
    });
    expect(chooseAdoptable([agent], HOME, 'novakai-shell')).toBeNull();
  });

  it('never adopts a shell another process opened', () => {
    const theirs = view({
      terminalSessionId: 'terminal_cli',
      owner: { kind: 'plain-shell', label: 'cli-48120' },
    });
    expect(chooseAdoptable([theirs], HOME, 'novakai-shell')).toBeNull();
  });

  it('never adopts a session in a different working directory', () => {
    const elsewhere = view({ workingDirectory: '/tmp/somewhere-else' });
    expect(chooseAdoptable([elsewhere], HOME, 'novakai-shell')).toBeNull();
  });

  it('never adopts a session that is not live', () => {
    const done = view({ status: 'exited' });
    expect(chooseAdoptable([done], HOME, 'novakai-shell')).toBeNull();
  });

  it('picks its own session out of a machine full of other people\'s', () => {
    const candidates = [
      view({ terminalSessionId: 'terminal_agent', owner: { kind: 'agent-run', label: 'agentRun_7' } }),
      view({ terminalSessionId: 'terminal_cli', owner: { kind: 'plain-shell', label: 'cli-48120' } }),
      view({ terminalSessionId: 'terminal_other-dir', workingDirectory: '/elsewhere' }),
      view({ terminalSessionId: 'terminal_mine' }),
    ];
    expect(chooseAdoptable(candidates, HOME, 'novakai-shell')?.terminalSessionId)
      .toBe('terminal_mine');
  });

  it('is deterministic when more than one session genuinely qualifies', () => {
    const first = view({ terminalSessionId: 'terminal_aaa' });
    const second = view({ terminalSessionId: 'terminal_bbb' });
    expect(chooseAdoptable([second, first], HOME, 'novakai-shell')?.terminalSessionId)
      .toBe(chooseAdoptable([first, second], HOME, 'novakai-shell')?.terminalSessionId);
  });
});
