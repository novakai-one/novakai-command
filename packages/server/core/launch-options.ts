/* eslint-disable id-length -- `ok` is the frozen result discriminant every B3
   caller reads (FZ-CLI-SCHEMA-011). A refusal that spelled it differently
   would not be a Result. */
// packages/server/core/launch-options.ts — what an `nvk-server` invocation
// resolves to, decided in one testable place instead of inside the CLI script.
//
// The CLI is an inbound adapter: it translates argv and environment into the
// options `bootServer` already publishes, and it holds no policy of its own.
// Two of those translations were defects (B3E-ENTRY-LIST E-02/E-03):
//
//   * an unstated port silently became 5180 — the port Chris's live server
//     binds. A harness or dev boot could take down the real instance. A port
//     is now always a stated decision;
//   * the watchdog registry was written next to the CLI's own source tree, so
//     a throwaway data root still left state inside the product checkout.
//     Server state now belongs to the data root that owns the rest of it.
import path from 'node:path';

/** The port Chris's live instance binds. Never a default — only ever a choice. */
export const LIVE_SERVER_PORT = 5180;

/** The vite lane's variable, which this server does NOT read. Named, not honoured. */
const FOREIGN_PORT_VAR = 'NOVAKAI_SERVER_PORT';

export interface ServerLaunch {
  readonly root: string;
  readonly port: number;
  readonly cwd: string;
  readonly staticDir: string;
  readonly watchdogDir: string;
  readonly kimiCliPath?: string;
}

export interface ServerLaunchRefusal {
  readonly code: 'PortNotChosen' | 'PortInvalid';
  readonly message: string;
}

export type ServerLaunchResult =
  | { ok: true; value: ServerLaunch }
  | { ok: false; error: ServerLaunchRefusal };

export interface ResolveServerLaunchInput {
  /** Raw `process.argv`. */
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** The checkout the CLI ships in — the source of the shell bundle, nothing else. */
  readonly repoRoot: string;
}

const PORT_HELP =
  `pass --port <n> or set NOVAKAI_PORT. ${LIVE_SERVER_PORT} is the live instance's port, `
  + 'so it is never assumed — use --port 0 to let the OS pick a free one';

const flagIn = (argv: readonly string[], name: string): string | undefined => {
  const found = argv.indexOf(`--${name}`);
  return found >= 0 ? argv[found + 1] : undefined;
};

/**
 * The data root, resolved the one way. The offline subcommands (`doctor`,
 * `config-set`) need it before there is any question of a port, so it is its
 * own step rather than a field only the boot path can reach.
 */
export function resolveDataRoot(input: ResolveServerLaunchInput): string {
  return flagIn(input.argv, 'root') ?? input.env.NOVAKAI_ROOT ?? path.join(input.repoRoot, '.novakai');
}

export function resolveServerLaunch(input: ResolveServerLaunchInput): ServerLaunchResult {
  const flag = (name: string): string | undefined => flagIn(input.argv, name);

  const port = resolvePort(flag('port'), input.env);
  if (!port.ok) return port;

  const root = resolveDataRoot(input);
  return {
    ok: true,
    value: {
      root,
      port: port.value,
      cwd: flag('cwd') ?? input.repoRoot,
      staticDir: flag('static') ?? path.join(input.repoRoot, 'packages', 'shell', 'dist'),
      // The registry is server state, so it lives with the rest of this root's
      // state. An operator who wants it somewhere else says so.
      watchdogDir: flag('watchdog-dir') ?? input.env.NOVAKAI_WATCHDOG_DIR ?? root,
      ...(flag('kimi-cli') === undefined ? {} : { kimiCliPath: flag('kimi-cli')! }),
    },
  };
}

function resolvePort(
  fromFlag: string | undefined, env: NodeJS.ProcessEnv,
): { ok: true; value: number } | { ok: false; error: ServerLaunchRefusal } {
  const stated = fromFlag ?? env.NOVAKAI_PORT;
  if (stated === undefined) {
    // Being told a port under the WRONG name is the failure the harness seat
    // actually hit, so it gets its own sentence rather than the generic one.
    const misnamed = env[FOREIGN_PORT_VAR] === undefined
      ? ''
      : ` ${FOREIGN_PORT_VAR} is the vite lane's variable and this server does not read it —`
        + ' set NOVAKAI_PORT instead.';
    return { ok: false, error: { code: 'PortNotChosen', message: `no port was chosen: ${PORT_HELP}.${misnamed}` } };
  }
  if (!/^\d+$/.test(stated) || Number(stated) > 65535) {
    return {
      ok: false,
      error: { code: 'PortInvalid', message: `"${stated}" is not a port — expected an integer 0–65535` },
    };
  }
  return { ok: true, value: Number(stated) };
}
