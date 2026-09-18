import { useEffect, useState } from 'react';
import { useCanWriteAdmin } from '../role.js';
import { formatExactDateTime, type ReviewMessage } from './paymentReview.js';

/**
 * «پیام به مشتری» — one of a few ready-made texts goes to a customer through
 * the bot. Built for the payment review page (#320) and used again on the
 * reseller-request page (#330, Sam: «همینو می‌خوام برای نماینده‌ها»), so the
 * three URLs are the caller's: where the list is read, where an ADMIN saves
 * it, and where one text is sent from. The list is the shop's, in settings —
 * Sam adds texts as they come up, so nothing is hard-coded. Sending is the
 * operator's act and does not close the screen it is on.
 */
export function CustomerMessageSection({
  listUrl,
  saveUrl,
  sendUrl,
  messagedAt,
  messagedTemplate,
  writeProps,
  onSent,
  onError,
}: {
  listUrl: string;
  saveUrl: string;
  sendUrl: string;
  messagedAt: number | null;
  messagedTemplate: string | null;
  /** The disabled/title pair for this page's role gate (`useWriteProps` or `useAdminWriteProps`). */
  writeProps: Record<string, unknown>;
  onSent: () => void;
  onError: (message: string) => void;
}) {
  const w = writeProps;
  const canEdit = useCanWriteAdmin();
  const [templates, setTemplates] = useState<ReviewMessage[] | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  async function load() {
    const r = await fetch(listUrl);
    if (!r.ok) return;
    const j = (await r.json().catch(() => ({}))) as { items?: ReviewMessage[] };
    // The shape, not just presence: the list is what the server says it is.
    const items = Array.isArray(j.items)
      ? j.items.filter((t) => typeof t?.key === 'string' && typeof t?.text === 'string')
      : [];
    setTemplates(items);
    setKey((k) => (items.some((t) => t.key === k) ? k : (items[0]?.key ?? '')));
  }
  useEffect(() => {
    void load();
  }, []);

  async function send() {
    if (!key) return;
    setBusy(true);
    try {
      const r = await fetch(sendUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          j.error === 'no_telegram_chat'
            ? 'این مورد به چت تلگرامی وصل نیست.'
            : (j.error ?? `${r.status}`),
        );
      }
      onSent();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'message_failed');
    } finally {
      setBusy(false);
    }
  }

  const chosen = templates?.find((t) => t.key === key);
  const last = messagedTemplate
    ? (templates?.find((t) => t.key === messagedTemplate)?.text ?? messagedTemplate)
    : null;
  return (
    <section className="drawer-section">
      <h3 className="drawer-section__heading">پیام به مشتری</h3>
      {messagedAt != null && (
        <p className="muted">
          آخرین پیام {formatExactDateTime(messagedAt)}
          {last ? `: «${last}»` : ''}
        </p>
      )}
      {templates && templates.length === 0 && (
        <p className="muted">هنوز متنی تعریف نشده است.</p>
      )}
      {templates && templates.length > 0 && (
        <>
          <label>
            متن آماده
            {/* `form-control` is the panel's field class; the hub styles the
                element itself, so the class is inert there and load-bearing
                on the reseller-request page. */}
            <select className="form-control" value={key} onChange={(e) => setKey(e.target.value)}>
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.text.length > 60 ? `${t.text.slice(0, 60)}…` : t.text}
                </option>
              ))}
            </select>
          </label>
          {chosen && <p className="muted payment-review__message-preview">{chosen.text}</p>}
        </>
      )}
      <div className="payment-review__actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !chosen}
          onClick={() => void send()}
          {...w}
        >
          ارسال از طریق ربات
        </button>
        {canEdit && (
          <button type="button" className="ghost" onClick={() => setEditing(true)}>
            ویرایش فهرست
          </button>
        )}
      </div>
      {editing && templates && (
        <ReviewMessagesEditor
          items={templates}
          saveUrl={saveUrl}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
          onError={onError}
        />
      )}
    </section>
  );
}

/**
 * The list itself. A key is minted once, when a text is added, and never
 * changes: the bot's outbox dedupes on it, so renaming a key would let the
 * same text reach the same customer twice for the same claim.
 */
function ReviewMessagesEditor({
  items,
  saveUrl,
  onClose,
  onSaved,
  onError,
}: {
  items: ReviewMessage[];
  saveUrl: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<ReviewMessage[]>(items);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const r = await fetch(saveUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: draft.map((t) => ({ key: t.key, text: t.text.trim() })) }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `${r.status}`);
      }
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="ویرایش متن‌های آماده"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-body">
        <h3>متن‌های آمادهٔ پیام به مشتری</h3>
        <p className="muted">هر متن یک‌بار برای هر پرداخت می‌رود؛ همان متن دوباره به همان مشتری نمی‌رسد.</p>
        {draft.map((t, i) => (
          <label key={t.key}>
            متن {i + 1}
            <textarea
              className="form-control"
              value={t.text}
              rows={2}
              maxLength={1000}
              onChange={(e) =>
                setDraft((d) => d.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
              }
            />
            <button
              type="button"
              className="ghost"
              onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
            >
              حذف
            </button>
          </label>
        ))}
        <div className="payment-review__actions">
          <button
            type="button"
            className="ghost"
            disabled={draft.length >= 50}
            onClick={() =>
              setDraft((d) => [...d, { key: `m${Date.now().toString(36)}`, text: '' }])
            }
          >
            + متن تازه
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || draft.some((t) => !t.text.trim())}
            onClick={() => void save()}
          >
            ذخیره
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            انصراف
          </button>
        </div>
      </div>
    </div>
  );
}

