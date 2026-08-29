import { idPatterns, type EventCursor } from './types.js';

const eventCursorPattern = new RegExp(idPatterns.EventCursor, 'u');

/** The single runtime parser for Event Cursors accepted by the contract. */
export function parseEventCursor(value: unknown): EventCursor | undefined {
  return typeof value === 'string' && eventCursorPattern.test(value)
    ? value as EventCursor
    : undefined;
}
