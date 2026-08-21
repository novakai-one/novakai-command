import { useState, type FormEvent } from 'react';
import type { BenchNodeActions } from '../model/bench-model';
import './MessageComposer.css';

/** Local composer that submits only meaningful text through the host command port. */
export function MessageComposer({
  threadId,
  actions,
}: {
  threadId: string;
  actions: BenchNodeActions;
}) {
  const [draft, setDraft] = useState('');
  const canSend = draft.trim().length > 0;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;
    actions.sendMessage(threadId, draft);
    setDraft('');
  };

  return (
    <form className="bench-composer nodrag nowheel" onSubmit={submit}>
      <label htmlFor={`bench-composer:${threadId}`}>Message this conversation</label>
      <textarea
        id={`bench-composer:${threadId}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Write the next useful thing…"
        rows={2}
      />
      <button type="submit" disabled={!canSend} aria-label="Send message">
        Send
      </button>
    </form>
  );
}
