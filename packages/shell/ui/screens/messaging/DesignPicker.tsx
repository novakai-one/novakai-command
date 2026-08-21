// shell/ui/screens/messaging/DesignPicker.tsx — pick the Messages design.
// Kit-composed (M1-08); the choice persists as the shell setting
// 'messagesDesign' and survives reload (M1-07). One registered design still
// renders the control, so the setting round-trip stays drivable.
import React, { useState } from 'react';
import type { ShellServices } from '../../../contract/index.js';
import { mintShellOpId } from '../../../contract/index.js';
import { listMessagesDesigns } from '../../messages-designs/registry';
import { Select, Stack, Text } from '../../kit/index.js';
import { MESSAGES_DESIGN_SETTING } from './MessagingScreen.js';

export function DesignPicker(props: {
  services: ShellServices;
  current: string;
  refreshSettings(): Promise<void>;
}) {
  const designs = listMessagesDesigns();
  // M4: a failed persist surfaces inline — never void-swallowed.
  const [error, setError] = useState<string | null>(null);
  return (
    <Stack
      className="nv-design-picker"
      style={{ position: 'absolute', top: 10, right: 12, zIndex: 40, width: 148 }}
    >
      <Select
        label="Messages design"
        value={props.current}
        options={designs.map((d) => ({ value: d.id, label: d.label }))}
        onChange={(id) => {
          void props.services
            .setSetting(MESSAGES_DESIGN_SETTING, id, { clientOpId: mintShellOpId() })
            .then(async (res) => {
              setError(res.ok ? null : res.error.message);
              if (res.ok) await props.refreshSettings();
            });
        }}
      />
      {error && (
        <Text role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--text-xs, 11px)' }}>
          Design not saved: {error}
        </Text>
      )}
    </Stack>
  );
}
