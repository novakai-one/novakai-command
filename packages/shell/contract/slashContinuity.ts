// shell/contract/slashContinuity.ts — FZ-VIEW-032 (B3R-014), the whole row.
//
//   Raw mode passes provider-native slash commands through unchanged **under
//   the input lease**; Calm/Message mode is owned by the **Shell Novakai
//   command registry**; `/btw`, `/side`, `/plugins` keep their existing Novakai
//   meaning; a provider-native command in Calm is either routed through a
//   **named provider control contract** or rejected with a plain explanation —
//   **never guessed**; **Terminal package does not parse slash commands**.
//
// ONE question, ONE home: *what does this typed line mean, on this surface,
// right now?* Pure — no React, no services, no clock. The surface, the lease and
// the doors arrive as data, which is what makes "Raw is the provider's" and
// "Calm is Novakai's" two branches of one function instead of two screens that
// have to agree.
//
// THE THING THIS FILE EXISTS TO PREVENT. Before it, `/model opus` typed in Calm
// cleared the composer and did NOTHING — `onProvider` was `void name; void
// args;`. That is the guess in its most dangerous form: the UI implied the model
// had changed. FZ-VIEW-032's "never guessed" is not about picking the wrong
// command, it is about ACTING AS IF a route exists. So the refusal is a value
// here, it names the route Chris does have, and a caller cannot reach the
// provider without going through a name in the closed set below.
import { unknownCommand, type UnknownCommandError } from './errors.js';
import { SHELL_BUILTINS, type SlashCommand } from './composer.js';

/**
 * The two surfaces of the row. Not "which screen is mounted" — the same tab
 * flips between them (FZ-VIEW-017), and the flip changes who owns a keystroke.
 */
export type SlashSurface = 'raw' | 'calm';

/**
 * The three names the row protects. Their Novakai meaning predates B3 and the
 * ratified corpus never restates it, so this build does not implement them —
 * see `SHELL_SLASH_DOORS.reservedNovakaiCommands` and finding L-19. What it CAN
 * do, and what the row actually requires, is stop a provider from taking the
 * words: a provider declaring `/btw` must not turn a Novakai side note into a
 * model prompt.
 */
export const NOVAKAI_RESERVED_NAMES = ['btw', 'side', 'plugins'] as const;

/**
 * The named provider control contract, and it is CLOSED: `AgentControl.name` is
 * `"model" | "effort" | "provider-setting"` (FZ-VIEW-029/030, P2 §12.7:2029).
 * A fourth entry here would be a control Novakai invented — the guess with a
 * respectable name.
 */
export const NAMED_PROVIDER_CONTROLS = ['model', 'effort', 'provider-setting'] as const;
export type NamedProviderControl = typeof NAMED_PROVIDER_CONTROLS[number];

/**
 * Which routes this HOST wired. Same shape and same reason as
 * `TerminalStopDoors` (contract/terminalClose.ts): the decision stays pure, the
 * composition root owns the answer, and "we cannot do that yet" is a stated fact
 * with one home rather than a `false` sprinkled through the screens.
 */
export interface SlashDoors {
  /**
   * Can this host apply a named provider control? `ShellAgentServices` is
   * READ-ONLY (runs · communications · supervision), and `applyAgentControl` is
   * reached through Lane A's `nvk agent control` (FZ-CLI-022), not through a
   * Shell door. So B3e passes `false` and the Shell tells Chris where to go.
   */
  readonly providerControl: boolean;
  /** Which of the reserved three this host actually implements. B3e: none. */
  readonly reservedNovakaiCommands: readonly string[];
}

export const SHELL_SLASH_DOORS: SlashDoors = {
  providerControl: false,
  reservedNovakaiCommands: [],
};

/**
 * Where the line was typed and what is true there.
 *
 * `providerDeclared` is what the provider said it understands. Note what it is
 * NOT: a route. Declaration earns a place in the palette and a specific refusal;
 * running it needs a name in `NAMED_PROVIDER_CONTROLS` *and* an open door.
 */
export interface SlashSituation {
  readonly surface: SlashSurface;
  /**
   * Raw only. §13.4: many attachments may read, exactly one active lease
   * generation may write. Without it the keystrokes go nowhere, and a composer
   * that clears itself anyway has told Chris they were sent.
   */
  readonly holdsInputLease: boolean;
  readonly providerDeclared: readonly string[];
  readonly doors: SlashDoors;
}

/**
 * `refused` and `unknown` are deliberately different answers. "I do not know
 * that word" and "I know exactly what that is and cannot do it here" are two
 * different things to be told, and only the second one has a next step.
 */
export type SlashAnswer =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'raw-passthrough'; readonly text: string }
  | { readonly kind: 'raw-blocked'; readonly because: string }
  | { readonly kind: 'novakai'; readonly name: string; readonly args: string }
  | {
    readonly kind: 'provider-control';
    readonly control: { readonly name: NamedProviderControl; readonly value: string };
    readonly route: 'nvk-agent-control';
  }
  | { readonly kind: 'refused'; readonly because: string; readonly instead: string | null }
  | { readonly kind: 'unknown'; readonly error: UnknownCommandError };

const isReserved = (name: string): boolean =>
  (NOVAKAI_RESERVED_NAMES as readonly string[]).includes(name);

const isNamedControl = (name: string): name is NamedProviderControl =>
  (NAMED_PROVIDER_CONTROLS as readonly string[]).includes(name);

/**
 * Is this line being typed as a command, and how far in? Returns the partial
 * name, or `null` once it is plainly not one.
 *
 * It lives here rather than in the composer because `'/'` is the sigil, and the
 * sigil is exactly the thing FZ-VIEW-032 says only one module may know. A screen
 * that decides for itself when a line "looks like a command" is the second
 * parser arriving by the back door.
 */
export function palettePartial(value: string): string | null {
  if (!value.startsWith('/')) return null;
  const body = value.slice(1);
  return body.includes(' ') ? null : body;
}

/**
 * What the palette may OFFER. Not "every name anyone mentioned" — every name
 * that can actually run here.
 *
 * Three rules, all of them learned from screenshots rather than tests. Raw
 * offers nothing: the Shell does not parse there, so a Novakai palette over a
 * Raw terminal would be a menu whose items go to the provider instead. A
 * declared provider command outside the named control set is left out. And a
 * NAMED control is left out too unless the door is actually open — the first
 * screenshot of this page offered `/model` on a host that can only refuse it,
 * which is the dead-control defect wearing the name of the rule against it.
 *
 * One test: could pressing this row do the thing the row says? If not, it is not
 * a row (seat 6, defect 2).
 */
export function slashPalette(
  partial: string,
  situation: SlashSituation,
  declared: readonly SlashCommand[] = [],
): readonly SlashCommand[] {
  if (situation.surface === 'raw') return [];
  const p = partial.toLowerCase();
  const reserved: SlashCommand[] = situation.doors.reservedNovakaiCommands
    .filter(isReserved)
    .map((name) => ({ name, description: 'Novakai command', source: 'shell' }));
  const controls = situation.doors.providerControl
    ? declared.filter((c) => isNamedControl(c.name) && !isReserved(c.name))
    : [];
  return [...SHELL_BUILTINS, ...reserved, ...controls]
    .filter((c) => c.name.toLowerCase().startsWith(p));
}

/** The "did you mean" list on an unknown word — the same candidates the palette
 * would have offered, so the two can never disagree. */
export function suggestSlash(partial: string, situation: SlashSituation): readonly string[] {
  const declared: SlashCommand[] = situation.providerDeclared
    .map((name) => ({ name, description: '', source: 'provider' as const }));
  return slashPalette(partial, situation, declared).map((c) => `/${c.name}`);
}

/**
 * THE ANSWER.
 *
 * Raw first, and it returns before anything is parsed. That ordering is the
 * "Terminal package does not parse slash commands" clause held from the other
 * end: in Raw the Shell does not parse either, so there is no second place a
 * `/` can acquire a meaning.
 */
export function readSlashInput(input: string, situation: SlashSituation): SlashAnswer {
  if (situation.surface === 'raw') {
    if (!situation.holdsInputLease) {
      // Says ONLY what a missing lease proves. The first draft read "another
      // controller holds the write lease" and got screenshotted over a session
      // that had EXITED — nobody held anything. "No lease" is not "somebody
      // else has it", the same way "no controller" is not "Agent stopped"
      // (FZ-VIEW-034). Who has it, if anyone, is the caller's fact to add.
      return {
        kind: 'raw-blocked',
        because: 'This window holds no write lease for this session, so nothing was sent.',
      };
    }
    // Byte-for-byte. Not trimmed, not re-joined: a provider is entitled to the
    // whitespace it was given, and "unchanged" is the word the row uses.
    return { kind: 'raw-passthrough', text: input };
  }

  if (!input.startsWith('/')) return { kind: 'message', text: input };

  const body = input.slice(1);
  const space = body.indexOf(' ');
  const name = (space === -1 ? body : body.slice(0, space)).trim();
  const args = space === -1 ? '' : body.slice(space + 1).trim();

  // 1. Shell built-ins. A provider cannot shadow one.
  if (SHELL_BUILTINS.some((c) => c.name === name)) return { kind: 'novakai', name, args };

  // 2. The reserved three. Novakai's words whether or not this build can run
  //    them — a provider declaring the same name never reaches step 3.
  if (isReserved(name)) {
    if (situation.doors.reservedNovakaiCommands.includes(name)) {
      return { kind: 'novakai', name, args };
    }
    return {
      kind: 'refused',
      because: `/${name} is a Novakai command, not a provider one, and this build has no `
        + 'operation behind it yet — so nothing was sent to the agent.',
      instead: situation.providerDeclared.includes(name)
        ? `Your provider also understands /${name}. Switch this tab to Raw to send it there.`
        : null,
    };
  }

  // 3. A named provider control — the only provider route Calm has.
  if (isNamedControl(name)) {
    if (!situation.providerDeclared.includes(name)) {
      return {
        kind: 'refused',
        because: `Novakai has not been told this provider understands /${name}, so sending it `
          + 'would be a guess.',
        instead: `Run nvk agent controls <agentRunId> to see which controls it reports.`,
      };
    }
    if (!args) {
      return {
        kind: 'refused',
        because: `/${name} needs a value, and Novakai will not choose one for you.`,
        instead: `Type /${name} <value> — nvk agent controls <agentRunId> lists the values it accepts.`,
      };
    }
    if (!situation.doors.providerControl) {
      return {
        kind: 'refused',
        because: `Novakai can carry /${name} as a control, but this window has no door to apply `
          + 'one — nothing was sent.',
        instead: `nvk agent control <agentRunId> --name ${name} --value ${args}`,
      };
    }
    return { kind: 'provider-control', control: { name, value: args }, route: 'nvk-agent-control' };
  }

  // 4. Declared by the provider, but outside the named set. This is the clause:
  //    routed by NAME or refused, never guessed. An open door does not widen it.
  if (situation.providerDeclared.includes(name)) {
    return {
      kind: 'refused',
      because: `Your provider understands /${name}, but Novakai has no named control for it, `
        + 'so it was not sent from here.',
      instead: `Switch this tab to Raw and type /${name} — Raw goes straight to the provider.`,
    };
  }

  // 5. Nobody's word.
  return { kind: 'unknown', error: unknownCommand(`/${name}`, [...suggestSlash(name.slice(0, 2), situation)]) };
}
