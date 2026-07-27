// shell/ui/screens/messaging/FocusChip.tsx — the composer's context chip
// (S2b demo affordance, req 9): shows what will travel with the next message.
import React from 'react';
import type { ScreenContext } from '../../../contract/index.js';

const APP_LABELS: Record<string, string> = {
  messaging: 'Messaging',
  agents: 'Agents',
  settings: 'Settings',
};

export function FocusChip(props: { focus: ScreenContext }) {
  const { focus } = props;
  const appLabel = APP_LABELS[focus.app] ?? focus.app;
  return (
    <span className="nv-context-chip" aria-label="Screen context attached to your next message">
      {focus.ref === 'none'
        ? '👁 nothing focused'
        : `👁 ${appLabel} · ${focus.ref.id}`}
    </span>
  );
}
