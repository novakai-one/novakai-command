// shell/contract/composer.ts — the Shell's Novakai command REGISTRY (SHL-005,
// R3-13, FZ-VIEW-032).
//
// Declaration only. What a typed line MEANS is decided in one place —
// `contract/slashContinuity.ts` — and this file no longer parses anything: it
// holds the Shell's own command set and the names a provider has told us it
// understands. Keeping the two apart is what "never a second registry" buys:
// a provider can add a NAME, and it still cannot add a ROUTE.
//
// Dependency runs ONE way: slashContinuity reads this file, never the reverse.
export interface SlashCommand {
  name: string;          // without the leading '/'
  description: string;   // one calm sentence
  source: 'shell' | 'provider';
}

export const SHELL_BUILTINS: SlashCommand[] = [
  { name: 'new', description: 'Start a new chat', source: 'shell' },
  { name: 'pin', description: 'Pin this chat', source: 'shell' },
  { name: 'archive', description: 'Archive this chat', source: 'shell' },
  { name: 'speed', description: 'Set thread render speed', source: 'shell' },
  { name: 'theme', description: 'Switch theme (dark | light)', source: 'shell' },
];

export class SlashRegistry {
  private providerCommands = new Map<string, SlashCommand>();

  /** Providers declare their slash set at registration (R3-13). */
  registerProviderCommand(cmd: { name: string; description: string }): void {
    this.providerCommands.set(cmd.name, { ...cmd, source: 'provider' });
  }

  all(): SlashCommand[] {
    return [...SHELL_BUILTINS, ...this.providerCommands.values()];
  }

  /** What the provider says it understands. Names, because a declaration is
   * evidence about the provider, not a route through Novakai. */
  declaredNames(): readonly string[] {
    return [...this.providerCommands.keys()];
  }

  declared(): readonly SlashCommand[] {
    return [...this.providerCommands.values()];
  }
}
