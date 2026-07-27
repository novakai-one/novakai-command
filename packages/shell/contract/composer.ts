// shell/contract/composer.ts — slash-command dispatch (SHL-005, R3-13).
// Order: shell built-ins → provider-declared → unknown = typed UnknownCommand.
// Provider commands are structured contract messages — never stdin injection.
import { unknownCommand, type UnknownCommandError } from './errors.js';

export interface SlashCommand {
  name: string;          // without the leading '/'
  description: string;   // one calm sentence
  source: 'shell' | 'provider';
}

export type DispatchResult =
  | { kind: 'builtin'; name: string; args: string }
  | { kind: 'provider'; name: string; args: string }
  | { kind: 'message'; text: string }
  | { kind: 'error'; error: UnknownCommandError };

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

  /** Autocomplete candidates for a partial name (palette contents). */
  suggest(partial: string): SlashCommand[] {
    const p = partial.toLowerCase();
    return this.all().filter((c) => c.name.toLowerCase().startsWith(p));
  }

  dispatch(input: string): DispatchResult {
    if (!input.startsWith('/')) return { kind: 'message', text: input };
    const body = input.slice(1);
    const space = body.indexOf(' ');
    const name = (space === -1 ? body : body.slice(0, space)).trim();
    const args = space === -1 ? '' : body.slice(space + 1).trim();
    if (SHELL_BUILTINS.some((c) => c.name === name)) return { kind: 'builtin', name, args };
    if (this.providerCommands.has(name)) return { kind: 'provider', name, args };
    const suggestions = this.suggest(name.slice(0, 2)).map((c) => `/${c.name}`);
    return { kind: 'error', error: unknownCommand(`/${name}`, suggestions) };
  }
}
