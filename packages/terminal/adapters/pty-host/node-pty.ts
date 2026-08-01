// The real PTY host.
//
// The only place in Terminal that knows a process exists. What gets launched is
// decided HERE from a named launch authority, never from a caller-supplied
// argv — that is what keeps "run anything you like" out of the public contract.
import { b3fail, b3err, b3ok, type B3Result } from '@novakai/foundation/contract';
import type { PtyExit, PtyHandle, PtyHost, PtyLaunchSpec } from '../../contract/ports.js';

/** What a named launch authority actually runs. */
export interface LaunchAuthority {
  readonly file: string;
  readonly args: readonly string[];
}

export type LaunchAuthorityRegistry = Readonly<Record<string, LaunchAuthority>>;

/**
 * B3a ships the two proofs the slice contract names: a plain shell, and one
 * mock managed session. Real provider PTYs arrive in B3b through the same
 * registry — no contract change, no new door.
 */
export function defaultLaunchAuthorities(
  environment: NodeJS.ProcessEnv = process.env,
): LaunchAuthorityRegistry {
  const shell = environment['SHELL'] ?? '/bin/zsh';
  return {
    'plain-shell': { file: shell, args: ['-l'] },
    'mock-managed': { file: shell, args: ['-c', MOCK_MANAGED_SCRIPT] },
  };
}

/** A deterministic stand-in for a provider CLI: it echoes and it stays up. */
const MOCK_MANAGED_SCRIPT = [
  'printf "novakai mock managed session ready\\n";',
  'while IFS= read -r line; do printf "mock> %s\\n" "$line"; done',
].join(' ');

export interface NodePtyHostOptions {
  readonly authorities?: LaunchAuthorityRegistry;
  readonly environment?: NodeJS.ProcessEnv;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      name: string; cwd: string; cols: number; rows: number;
      env: Record<string, string>;
    },
  ): NodePtyProcess;
}

interface NodePtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
}

/**
 * `node-pty` is loaded lazily so every non-PTY consumer — the contract suite,
 * the CLIs, a second host — runs without a native module present.
 */
export async function createNodePtyHost(options: NodePtyHostOptions = {}): Promise<PtyHost> {
  const authorities = options.authorities ?? defaultLaunchAuthorities(options.environment);
  const loaded = await import('node-pty') as unknown as NodePtyModule;
  const alive = new Map<string, () => boolean>();

  return {
    async start(spec: PtyLaunchSpec): Promise<B3Result<PtyHandle>> {
      const authority = authorities[spec.launchAuthorityRef];
      if (!authority) {
        return b3fail(b3err('UnsupportedOperation',
          `no launch authority named "${spec.launchAuthorityRef}"`,
          { operation: 'terminal.openManagedTerminal', reason: 'unknown-launch-authority' }, false));
      }
      try {
        const child = loaded.spawn(authority.file, authority.args, {
          name: 'xterm-256color',
          cwd: spec.workingDirectory,
          cols: spec.columns,
          rows: spec.rows,
          env: mergedEnvironment(options.environment ?? process.env, spec.environment),
        });
        const handle = new NodePtyHandle(child);
        alive.set(handle.processRef, () => handle.isAlive());
        return b3ok(handle);
      } catch (cause) {
        return b3fail(b3err('UnsupportedOperation',
          `could not start a terminal: ${cause instanceof Error ? cause.message : String(cause)}`,
          { operation: 'terminal.openManagedTerminal', reason: 'pty-spawn-failed' }, false));
      }
    },

    probe(processRef: string): boolean {
      const known = alive.get(processRef);
      if (known) return known();
      // A ref from a PREVIOUS runtime: all we can do is ask the OS whether that
      // pid still exists, and say so honestly.
      const processId = Number.parseInt(processRef.replace('pid:', ''), 10);
      if (!Number.isInteger(processId) || processId <= 0) return false;
      try {
        process.kill(processId, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function mergedEnvironment(
  base: NodeJS.ProcessEnv, extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (typeof value === 'string') merged[name] = value;
  }
  for (const [name, value] of Object.entries(extra ?? {})) merged[name] = value;
  return merged;
}

class NodePtyHandle implements PtyHandle {
  readonly processRef: string;
  private living = true;

  constructor(private readonly child: NodePtyProcess) {
    this.processRef = `pid:${child.pid}`;
    child.onExit(() => { this.living = false; });
  }

  write(data: string): void {
    this.child.write(data);
  }

  resize(columns: number, rows: number): void {
    this.child.resize(columns, rows);
  }

  kill(): void {
    this.child.kill();
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.child.onData((data) => listener(Buffer.from(data, 'utf8')));
  }

  onExit(listener: (exit: PtyExit) => void): void {
    this.child.onExit((event) => {
      this.living = false;
      listener({
        exitCode: event.exitCode,
        ...(event.signal === undefined ? {} : { signal: String(event.signal) }),
      });
    });
  }

  isAlive(): boolean {
    return this.living;
  }
}
