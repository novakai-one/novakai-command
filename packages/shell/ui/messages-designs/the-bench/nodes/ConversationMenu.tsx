import { useEffect, useRef, useState } from 'react';
import type { ObjectRecord } from '../../contract';
import type { BenchConversation, BenchNodeActions } from '../model/bench-model';
import './ConversationMenu.css';

/** Thread-local action menu; every record mutation crosses the host command seam. */
export function ConversationMenu({
  conversation,
  missions,
  actions,
}: {
  conversation: BenchConversation;
  missions: readonly ObjectRecord[];
  actions: BenchNodeActions;
}) {
  const [isOpen, setOpen] = useState(false);
  const [missionId, setMissionId] = useState(conversation.mission?.record.id ?? missions[0]?.id ?? '');
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [isOpen]);

  return (
    <div
      ref={menuRef}
      className="bench-conversation-menu nodrag nowheel"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="bench-icon-control bench-conversation-menu__trigger"
        aria-label="Conversation actions"
        aria-expanded={isOpen}
        onClick={() => setOpen((open) => !open)}
      >
        •••
      </button>
      {isOpen && (
        <ConversationMenuItems
          conversation={conversation}
          missions={missions}
          actions={actions}
          missionId={missionId}
          setMissionId={setMissionId}
          copied={copied}
          setCopied={setCopied}
          close={() => setOpen(false)}
        />
      )}
    </div>
  );
}


/** The popover's menu items — one button per verb, none triggers another. */
function ConversationMenuItems({ conversation, missions, actions, missionId, setMissionId, copied, setCopied, close }: {
  conversation: BenchConversation;
  missions: readonly ObjectRecord[];
  actions: BenchNodeActions;
  missionId: string;
  setMissionId: (id: string) => void;
  copied: boolean;
  setCopied: (copied: boolean) => void;
  close: () => void;
}) {
  return (
    <div className="bench-conversation-menu__popover" role="menu">
          <button type="button" role="menuitem" onClick={() => {
            actions.markThreadRead(conversation.thread.id);
            close();
          }}>
            Mark read
          </button>
          <label>
            <span>Attach to Mission</span>
            <select value={missionId} onChange={(event) => setMissionId(event.target.value)}>
              {missions.map((mission) => (
                <option key={mission.id} value={mission.id}>{mission.title}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            role="menuitem"
            disabled={!missionId}
            onClick={() => {
              if (missionId) actions.attachThreadToMission(conversation.thread.id, missionId);
              close();
            }}
          >
            Attach Mission
          </button>
          <button type="button" role="menuitem" onClick={() => {
            void navigator.clipboard.writeText(conversation.thread.id).then(() => setCopied(true));
          }}>
            {copied ? 'ID copied' : 'Copy thread ID'}
          </button>
          <button type="button" role="menuitem" onClick={() => {
            actions.pinConversation(conversation.thread.id, conversation.thread.fields.pinned !== true);
            close();
          }}>
            {conversation.thread.fields.pinned === true ? 'Unpin' : 'Pin'}
          </button>
          <button type="button" role="menuitem" onClick={() => {
            actions.shelveConversation(conversation.thread.id);
            close();
          }}>
            Remove from canvas
          </button>
          <button
            type="button"
            role="menuitem"
            className="bench-conversation-menu__danger"
            onClick={() => {
              actions.killAgent(conversation.thread.id);
              close();
            }}
          >
            Kill agent
          </button>
          <button
            type="button"
            role="menuitem"
            className="bench-conversation-menu__danger"
            onClick={() => actions.archiveConversation(conversation.thread.id)}
          >
            Archive
          </button>
        </div>
  );
}
