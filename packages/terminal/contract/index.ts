// packages/terminal/contract — the ONLY legal import surface for consumers.
// Nothing under core/ or adapters/ is importable from outside this package.
export * from './records.js';
export * from './api.js';
export * from './ports.js';
export { composeTerminal, type ComposeTerminalOptions } from '../core/compose.js';
