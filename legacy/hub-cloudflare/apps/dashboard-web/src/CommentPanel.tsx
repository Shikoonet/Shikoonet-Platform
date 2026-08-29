import { useEffect, useState } from 'react';
import { api, type CommentRow } from './api.js';
import { formatTime } from './format.js';

interface Props {
  entityType: 'MATCH' | 'TRANSACTION' | 'CLAIM';
  entityId: string | null;
}

export function CommentPanel({ entityType, entityId }: Props) {
  const [items, setItems] = useState<CommentRow[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = () => {
    if (!entityId) {
      setItems([]);
      return;
    }
    api.comments(entityType, entityId).then((r) => setItems(r.items));
  };

  useEffect(reload, [entityId, entityType]);

  async function submit() {
    if (!entityId || !draft.trim()) return;
    setBusy(true);
    try {
      await api.postComment(entityType, entityId, draft.trim());
      setDraft('');
      reload();
    } finally {
      setBusy(false);
    }
  }

  if (!entityId) {
    return <aside className="panel empty">Select a match to view comments.</aside>;
  }

  return (
    <aside className="panel">
      <h3>Comments</h3>
      {items.length === 0 ? (
        <p className="muted">No comments yet.</p>
      ) : (
        <ul>
          {items.map((c) => (
            <li key={c.id}>
              <div>{c.body}</div>
              <small className="muted">
                {c.author_email} • {formatTime(c.created_at)}
              </small>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="Add a comment…"
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          Post
        </button>
      </form>
    </aside>
  );
}
