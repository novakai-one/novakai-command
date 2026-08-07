// tools/slash-preview.tsx — a dev-only VISUAL proof of FZ-VIEW-032's Calm half,
// driven through the REAL `Composer`.
//
// Everything that decides anything here is shipped code: the real composer, the
// real `contract/slashContinuity.ts` answer, the real `SlashRegistry`. Nothing
// is stubbed — there is nothing to stub, because the whole point of the row is
// that Calm refuses BEFORE any provider is reached. The three handlers below
// only record what the composer decided to do, which is exactly the thing a
// screenshot cannot otherwise show: that a refusal sent nothing.
//
// The readout prints WHAT WAS ROUTED, not what the box displayed. A composer
// that clears itself looks identical whether it sent a message or dropped one
// on the floor — which is how the defect this slice fixes survived six seats.
//
// Not in the shipped bundle: `vite build` builds `index.html`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../ui/screens/messaging/Composer.js';
import { SlashRegistry } from '../contract/composer.js';
// tokens.css + kit.css arrive with the kit; this page needs the screen's own
// sheet too, since it mounts the composer without the messaging screen.
import '../ui/screens/messaging/messaging.css';

/** A provider that declares two commands: one Novakai has a NAME for (`model`,
 * an `AgentControl`) and one it does not (`compact`). Both are refused in Calm
 * by this build, for two different reasons — which is the row's whole shape. */
const registry = new SlashRegistry();
registry.registerProviderCommand({ name: 'model', description: 'switch model' });
registry.registerProviderCommand({ name: 'compact', description: 'compact the context' });
registry.registerProviderCommand({ name: 'btw', description: 'provider side note' });

const readout = document.querySelector('#readout');
const routed: string[] = [];
function record(line: string): void {
  routed.push(line);
  if (readout) readout.textContent = `routed: ${routed.join(' · ')}`;
}
record('nothing yet');

createRoot(document.querySelector('#preview') as HTMLElement).render(
  <Composer
    registry={registry}
    height={92}
    onResize={() => undefined}
    onSend={(text) => record(`message(${text})`)}
    onBuiltin={(name, args) => record(`novakai(/${name}${args ? ` ${args}` : ''})`)}
  />,
);
