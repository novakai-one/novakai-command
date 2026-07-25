// ComposerBar — the storyboard's pinned composer: drag handle, raised box,
// channel line, textarea, footer ("Draft saved" + inverted ↑ send button).
// Send rides the data plane's hook (N4): optimistic 'queued' row, the
// committed echo settles it, a failed POST marks it 'failed' (F4). Drafts
// persist per lane
// (lib/composerDraft); server errors (404 roster hint, 502 honest failure)
// render inline above the box. Typing @ at a word boundary opens the member
// picker (round 2): arrows move, Enter/Tab picks, Escape closes; picking
// writes "@label " so MentionText resolves it downstream.
import React, { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../../../../lib/messagingV2/index.js';
import type { MentionTarget } from '../../../../lib/mentions/index.js';
import { clearDraft, loadDraft, saveDraft } from '../../../../lib/composerDraft/index.js';
import {
  MESSAGING_SETTINGS,
  initialFor,
  mentionQueryAt,
  mentionSuggestions,
  roomLabelFor,
  type MentionQuery,
} from '../model.js';
import './index.css';

interface ComposerBarProps {
  conversation: Conversation;
  targets: MentionTarget[];
  onSend(body: string): Promise<void>;
}

export function ComposerBar({ conversation, targets, onSend }: ComposerBarProps) {
  const [draft, setDraft] = useState(() => loadDraft(conversation.id));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [savedVisible, setSavedVisible] = useState(() => loadDraft(conversation.id).trim() !== '');
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [pickIndex, setPickIndex] = useState(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  const suggestions = mention
    ? mentionSuggestions(targets, mention.query, MESSAGING_SETTINGS.mentionPicker.maxSuggestions)
    : [];
  const pickerOpen = mention !== null && suggestions.length > 0;

  useEffect(() => {
    const loaded = loadDraft(conversation.id);
    setDraft(loaded);
    setError(null);
    setSavedVisible(loaded.trim() !== '');
    setMention(null);
  }, [conversation.id]);

  // "Draft saved" appears once the field has sat untouched for 1s.
  useEffect(() => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    if (!draft.trim()) {
      setSavedVisible(false);
      return;
    }
    savedTimer.current = setTimeout(() => setSavedVisible(true), 1000);
  }, [draft, conversation.id]);

  // The picker's highlight resets whenever the query changes.
  useEffect(() => {
    setPickIndex(0);
  }, [mention?.query]);

  function syncMention(value: string, caret: number): void {
    setMention(mentionQueryAt(value, caret));
  }

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body);
      setDraft('');
      clearDraft(conversation.id);
      setSavedVisible(false);
      setMention(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  }

  function pickMention(target: MentionTarget): void {
    if (!mention) return;
    const caret = mention.start + 1 + mention.query.length;
    const inserted = `@${target.label} `;
    const nextDraft = draft.slice(0, mention.start) + inserted + draft.slice(caret);
    setDraft(nextDraft);
    saveDraft(conversation.id, nextDraft);
    setMention(null);
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(mention.start + inserted.length, mention.start + inserted.length);
    });
  }

  /** Returns true when the picker consumed the key. */
  function handlePickerKey(press: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!pickerOpen) return false;
    if (press.key === 'ArrowDown' || press.key === 'ArrowUp') {
      press.preventDefault();
      const step = press.key === 'ArrowDown' ? 1 : -1;
      setPickIndex((current) => (current + step + suggestions.length) % suggestions.length);
      return true;
    }
    if (press.key === 'Enter' || press.key === 'Tab') {
      press.preventDefault();
      pickMention(suggestions[pickIndex]);
      return true;
    }
    if (press.key === 'Escape') {
      press.preventDefault();
      setMention(null);
      return true;
    }
    return false;
  }

  function handleKeyDown(press: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (handlePickerKey(press)) return;
    if (press.key !== 'Enter' || press.shiftKey) return;
    press.preventDefault();
    void send();
  }

  const isDm = conversation.kind === 'dm';
  const channelLabel = isDm ? `@ ${conversation.title}` : `# ${roomLabelFor(conversation)}`;
  const hint = isDm ? `Message ${conversation.title}…` : `Message #${roomLabelFor(conversation)}…`;

  return (
    <form
      className="msg-composer"
      onSubmit={(submit) => {
        submit.preventDefault();
        void send();
      }}
    >
      <span className="msg-composer-handle" aria-hidden="true" />
      {error && <div className="msg-composer-error" role="alert">{error}</div>}
      <div className="msg-composer-box">
        <div className="msg-composer-channel">{channelLabel}</div>
        <textarea
          ref={areaRef}
          aria-label={`Message ${conversation.title}`}
          placeholder={hint}
          value={draft}
          onChange={(change) => {
            const nextDraft = change.target.value;
            setDraft(nextDraft);
            saveDraft(conversation.id, nextDraft);
            syncMention(nextDraft, change.target.selectionStart ?? nextDraft.length);
          }}
          onSelect={(select) => {
            const area = select.currentTarget;
            syncMention(area.value, area.selectionStart ?? 0);
          }}
          onBlur={() => setMention(null)}
          onKeyDown={handleKeyDown}
        />
        {pickerOpen && (
          <div className="msg-mentions" role="listbox" aria-label="Mention a member">
            {suggestions.map((target, index) => (
              <button
                key={target.objectId}
                type="button"
                role="option"
                aria-selected={index === pickIndex}
                className={index === pickIndex ? 'msg-mention-option is-picked' : 'msg-mention-option'}
                onMouseDown={(down) => down.preventDefault()}
                onClick={() => pickMention(target)}
              >
                <span className="msg-mention-av" aria-hidden="true">{initialFor(target.label)}</span>
                <span className="msg-mention-name">{target.label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="msg-composer-foot">
          <span className="msg-composer-saved">{savedVisible ? 'Draft saved' : ''}</span>
          <button
            type="submit"
            className="msg-send"
            aria-label="Send"
            disabled={!draft.trim() || sending}
          >
            ↑
          </button>
        </div>
      </div>
    </form>
  );
}
