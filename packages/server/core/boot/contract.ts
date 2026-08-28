/** Boot input, refusal and successful server contracts. */

import type { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import type { ProcessProbe, ProviderSessionRegistry } from '../../../agents/contract/index.js';
import type { ServerConfig } from '../../contract/config.js';
import type { B3RuntimeOptions } from '../b3/composition.js';
import type { ServerRuntime } from '../methods.js';
import type { SupervisionEngine } from '../supervision/engine.js';

export interface BootOptions {
  root: string;
  port: number;
  staticDir?: string;
  cwd?: string;
  kimiCliPath?: string;
  codexCliPath?: string;
  claudeCliPath?: string;
  providerHome?: string;
  supervisionTimers?: boolean;
  watchdogDir?: string;
  processProbe?: ProcessProbe;
  recordSystemAction?: typeof recordSystemAction;
  b3?: Omit<B3RuntimeOptions, 'root' | 'publish'>;
}

export interface BootStep {
  step: number;
  name: string;
  detail: string;
}

export interface BootError {
  code:
    | 'ConfigUnavailable'
    | 'NoHumanPrincipal'
    | 'StoreUnavailable'
    | 'RuntimeUnavailable';
  message: string;
}

export interface NovakaiServer {
  url: string;
  port: number;
  token: string;
  steps: BootStep[];
  interrupted: Array<{
    sessionId: string;
    clientOpId: string;
    reason: 'ReplyInterrupted';
  }>;
  sessions: ProviderSessionRegistry;
  supervision: SupervisionEngine;
  config: ServerConfig;
  runtime: ServerRuntime;
  close(): Promise<void>;
}

export type BootResult =
  | { ok: true; value: NovakaiServer }
  | { ok: false; error: BootError };

export type BootNote = (step: number, name: string, detail: string) => void;

export const refuse = (code: BootError['code'], message: string): BootResult => ({
  ok: false,
  error: { code, message },
});
