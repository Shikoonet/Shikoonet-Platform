/**
 * متن‌های ربات and چیدمان کیبورد — what the bot says, and the buttons it says it with.
 *
 * Neither screen validates anything itself. Both send the edit and render the
 * server's refusal, because the rules live in `@shikoo/contracts` next to the
 * defaults and the bot reads the same copy. A second implementation here that
 * agreed today would be the one that disagrees after the next change.
 *
 * The reset story is the same on both and is worth stating: resetting deletes
 * the override rather than writing the current default back, so a shop that
 * resets a sentence receives a later release's improved wording instead of
 * being frozen at the version they happened to reset against.
 */

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type BotMenu,
  type BotScreen,
  type BotTextRow,
  type EmojiPack,
  type KeyboardButton,
  type MenuActionInfo,
} from '../api.js';
import { count, dateTime } from '../format.js';
import { useAdminWriteProps } from '../role.js';
import { ButtonGrid, GRID_HELP, type GridRows } from './ButtonGrid.js';
import { BUTTON_STYLES, premiumEmojiTag, type ButtonStyle } from '@shikoo/contracts';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'unknown_key') return 'این متن در ربات وجود ندارد.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    // `detail` is the server's sentence for a broken placeholder or layout, and
    // it is more specific than anything this file could say.
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

export function BotTextsPage() {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<BotTextRow[]>([]);
  const [screens, setScreens] = useState<BotScreen[]>([]);
  const [maxLength, setMaxLength] = useState(4096);
  const [customEmoji, setCustomEmoji] = useState(false);
  const [packs, setPacks] = useState<EmojiPack[]>([]);
  const [packLink, setPackLink] = useState('');
  const [screen, setScreen] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try {
      const d = await api.botTexts();
      setRows(d.items);
      setScreens(d.screens);
      setMaxLength(d.maxLength);
      setCustomEmoji(d.customEmoji);
      // Its own failure, swallowed: the packs are a convenience beside the
      // editor, and a picker that could not load must not take the page that
      // edits the shop's wording down with it.
      setPacks(await api.emojiPacks().then((p) => p.packs).catch(() => []));
    } catch (e) {
      setErr(message(e));
    }
  }

  async function addPack() {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const res = await api.addEmojiPack(packLink.trim());
      setPackLink('');
      setPacks((await api.emojiPacks()).packs);
      setDone(res.message);
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function removePack(id: number) {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.hideEmojiPack(id);
      setPacks((await api.emojiPacks()).packs);
      setDone('پکیج برداشته شد. ایموجی‌هایی که از قبل در متن‌ها هستند دست‌نخورده می‌مانند.');
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleCustomEmoji(next: boolean) {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.setCustomEmoji(next);
      setCustomEmoji(next);
      setDone(
        next
          ? 'ایموجی سفارشی روشن شد. اگر صاحب ربات پرمیوم نداشته باشد، ربات اولین بار که تلگرام رد کند خودش خاموشش می‌کند.'
          : 'ایموجی سفارشی خاموش شد. متن‌هایی که تگ دارند با همان ایموجی جایگزین فرستاده می‌شوند.',
      );
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(row: BotTextRow, value: string) {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const out = await api.saveBotText(row.key, value);
      setDone(out.customised ? 'ذخیره شد.' : 'به متن پیش‌فرض برگشت.');
      setEditing(null);
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  const screenLabel = (id: string) => screens.find((s) => s.id === id)?.label ?? id;

  // Search covers what the admin actually remembers: the sentence itself, and
  // the note saying where it appears. Not the key — that is ours, not theirs.
  const needle = query.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (screen === '' || r.screen === screen) &&
      (needle === '' ||
        r.value.toLowerCase().includes(needle) ||
        r.hint.toLowerCase().includes(needle)),
  );
  const customised = rows.filter((r) => r.customised).length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">متن‌های ربات</div>
          <div className="page-head__sub">
            {count(rows.length)} متن · {count(customised)} تغییر داده شده
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <span className="card__title">ایموجی سفارشی تلگرام</span>
          <button
            type="button"
            className={customEmoji ? 'btn btn-primary' : 'btn'}
            disabled={busy}
            onClick={() => void toggleCustomEmoji(!customEmoji)}
          >
            {customEmoji ? 'روشن' : 'خاموش'}
          </button>
        </div>
        <p className="muted" style={{ marginBlockStart: 0 }}>
          وقتی روشن باشد، زیر هر متن دکمه‌های ایموجی پکیج‌هایتان ظاهر می‌شود و با یک کلیک داخل متن
          می‌نشیند. این فقط زمانی کار می‌کند که <strong>صاحب ربات</strong> اشتراک تلگرام پرمیوم
          داشته باشد — و راهی نیست که از قبل بشود فهمید. اگر تلگرام رد کند، همان پیام با ایموجی
          جایگزین فرستاده می‌شود و این کلید خودکار خاموش می‌شود؛ نوشتهٔ شما دست‌نخورده می‌ماند.
        </p>

        {/* The packs, and how one is added.
            The ids used to be a hand-written list in the source. That list had
            two entries sharing one id and five that ran sequentially — invented
            rather than observed — and an invented id renders nothing. So they
            are read from Telegram's own `getStickerSet` now, and the only thing
            an operator has to know is the link they already have. */}
        <div className="filters" style={{ alignItems: 'flex-end' }}>
          <div style={{ flexGrow: 1 }}>
            <label className="form-label" htmlFor="emoji-pack-link">
              افزودن پکیج ایموجی
            </label>
            <input
              id="emoji-pack-link"
              className="form-control ltr"
              placeholder="https://t.me/addemoji/…"
              value={packLink}
              onChange={(e) => setPackLink(e.target.value)}
              {...w}
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy || packLink.trim() === ''}
            onClick={() => void addPack()}
            {...w}
          >
            خواندن از تلگرام
          </button>
        </div>
        {packs.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBlockStart: 8 }}>
            {packs.map((pack) => (
              <span key={pack.id} className="chip" title={pack.setName}>
                {pack.title} · {count(pack.emoji.length)}
                {pack.setName !== '__builtin__' && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ marginInlineStart: 6 }}
                    disabled={busy}
                    onClick={() => void removePack(pack.id)}
                    {...w}
                  >
                    حذف
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="filters">
          <div>
            <label className="form-label" htmlFor="text-screen">
              صفحه
            </label>
            <select
              id="text-screen"
              className="form-control"
              value={screen}
              onChange={(e) => setScreen(e.target.value)}
            >
              <option value="">همه صفحه‌ها</option>
              {screens.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="text-search">
              جستجو
            </label>
            <input
              id="text-search"
              className="form-control"
              type="search"
              placeholder="بخشی از جمله یا توضیحش"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {err && <div className="alert alert-error">{err}</div>}
        {done && <div className="alert alert-info">{done}</div>}
        <p className="muted">
          هر متنی که دست نخورده باشد، همان چیزی است که ربات امروز می‌گوید. «بازگشت به پیش‌فرض» تغییر
          شما را حذف می‌کند، نه اینکه متن فعلی را رونویسی کند — پس نسخه‌های بعدی ربات هم به شما
          می‌رسند.
        </p>

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>متن</th>
                <th>کجا دیده می‌شود</th>
                <th>وضعیت</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key}>
                  <td style={{ maxWidth: 420 }}>
                    {editing === r.key ? (
                      <>
                        <textarea
                          className="form-control"
                          rows={5}
                          maxLength={maxLength}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                        />
                        {r.placeholders.length > 0 && (
                          <p className="muted" style={{ marginBlockEnd: 0 }}>
                            این متن باید{' '}
                            <span className="ltr">
                              {r.placeholders.map((p) => `{${p}}`).join('، ')}
                            </span>{' '}
                            را داشته باشد؛ جایش مقدار واقعی می‌نشیند.
                          </p>
                        )}
                        {/* The picker is the only place an operator can be
                            misled into thinking they pasted text: every chip
                            here inserts markup that only renders for a Premium
                            owner, and the row below says so in plain Persian
                            so the operator can choose. The chips themselves
                            stay visually identical to the BadgeField colour
                            squares — a Premium emoji IS a coloured glyph —
                            but they only appear when the feature is on, so an
                            operator who hasn't enabled it doesn't get a tool
                            that does nothing on save. */}
                        {customEmoji && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBlockStart: 6 }}>
                            {packs.flatMap((pack) =>
                              pack.emoji.map((e) => (
                                <button
                                  key={`${pack.id}-${e.id}`}
                                  type="button"
                                  className="btn btn-sm"
                                  title={`${pack.title} — ${e.id}`}
                                  onClick={() =>
                                    setDraft(
                                      (d) =>
                                        d + premiumEmojiTag({ label: pack.title, fallback: e.fallback, id: e.id }),
                                    )
                                  }
                                  {...w}
                                >
                                  {e.fallback}
                                </button>
                              )),
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <span style={{ whiteSpace: 'pre-wrap' }}>{r.value}</span>
                    )}
                  </td>
                  <td>
                    <div>{screenLabel(r.screen)}</div>
                    <div className="page-head__sub">{r.hint}</div>
                  </td>
                  <td>
                    {r.customised ? (
                      <>
                        <span className="badge badge-info">تغییر داده شده</span>
                        {r.updatedBy && <div className="page-head__sub ltr">{r.updatedBy}</div>}
                        {r.updatedAt && (
                          <div className="page-head__sub">{dateTime(r.updatedAt)}</div>
                        )}
                      </>
                    ) : (
                      <span className="badge">پیش‌فرض</span>
                    )}
                  </td>
                  <td>
                    {editing === r.key ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busy}
                          onClick={() => void save(r, draft)}
                          {...w}
                        >
                          ذخیره
                        </button>{' '}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setEditing(null)}
                        >
                          انصراف
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            setEditing(r.key);
                            setDraft(r.value);
                          }}
                          {...w}
                        >
                          ویرایش
                        </button>{' '}
                        {r.customised && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            // Saving the default back is what the server reads
                            // as "reset", and it deletes the row.
                            onClick={() => void save(r, r.default)}
                            {...w}
                          >
                            پیش‌فرض
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export function KeyboardPage() {
  const w = useAdminWriteProps();
  const [menu, setMenu] = useState('main');
  const [menus, setMenus] = useState<BotMenu[]>([]);
  const [buttons, setButtons] = useState<KeyboardButton[]>([]);
  const [actions, setActions] = useState<MenuActionInfo[]>([]);
  const [customised, setCustomised] = useState(false);
  const [maxLabel, setMaxLabel] = useState(64);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try {
      const d = await api.botKeyboard(menu);
      setButtons(d.buttons);
      setActions(d.actions);
      setMenus(d.menus);
      setCustomised(d.customised);
      setMaxLabel(d.maxLabelLength);
    } catch (e) {
      setErr(message(e));
    }
  }

  // Reloading on `menu` is the whole navigation: each keyboard is its own saved
  // layout, and switching screens must not carry the previous one's unsaved
  // edits across.
  useEffect(() => {
    void load();
  }, [menu]);

  /**
   * The board, from the saved positions.
   *
   * Hidden buttons are on it too, faded. They still have a position, and a
   * board that dropped them would be the only way to arrange buttons while
   * refusing to arrange one of them — which is what the row/column number
   * inputs used to be for.
   */
  const boardRows: GridRows = (() => {
    const byRow = new Map<number, KeyboardButton[]>();
    for (const b of buttons) {
      const row = byRow.get(b.rowIndex) ?? [];
      row.push(b);
      byRow.set(b.rowIndex, row);
    }
    return [...byRow.entries()]
      .sort(([a], [z]) => a - z)
      .map(([, row]) =>
        row
          .slice()
          .sort((x, y) => x.colIndex - y.colIndex)
          .map((b) => ({
            key: b.action,
            label: b.label,
            hint: b.action,
            tint: b.style ? STYLE_TOKENS[b.style] : null,
            dim: !b.visible,
          })),
      );
  })();

  function update(action: string, patch: Partial<KeyboardButton>) {
    setButtons((bs) => bs.map((b) => (b.action === action ? { ...b, ...patch } : b)));
  }

  function remove(action: string) {
    setButtons((bs) => bs.filter((b) => b.action !== action));
  }

  function add(action: string) {
    const info = actions.find((a) => a.action === action);
    if (!info) return;
    // Dropped onto a new row of its own; moving it is one edit and guessing
    // where they wanted it is a worse default than the obvious one.
    const nextRow = buttons.reduce((max, b) => Math.max(max, b.rowIndex), -1) + 1;
    setButtons((bs) => [
      ...bs,
      // No colour: a button an admin has just added should look like the ones
      // already there until they say otherwise.
      { action, label: info.label, rowIndex: nextRow, colIndex: 0, visible: true, style: null },
    ]);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.saveBotKeyboard(menu, buttons);
      setDone('کیبورد ذخیره شد. ربات تا نیم دقیقهٔ دیگر آن را نشان می‌دهد.');
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm('کیبورد به چیدمان پیش‌فرض برگردد؟ تغییرات شما حذف می‌شود.')) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.resetBotKeyboard(menu);
      setDone('به چیدمان پیش‌فرض برگشت.');
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  const present = new Set(buttons.map((b) => b.action));
  const missing = actions.filter((a) => !present.has(a.action));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">چیدمان کیبورد</div>
          <div className="page-head__sub">
            {menus.find((m) => m.id === menu)?.label ?? menu} ·{' '}
            {customised ? 'تغییر داده شده' : 'پیش‌فرض'}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void save()}
          {...w}
        >
          ذخیره
        </button>
      </div>

      <div className="card">
        {err && <div className="alert alert-error">{err}</div>}
        {done && <div className="alert alert-info">{done}</div>}

        <div className="filters">
          <div>
            <label className="form-label" htmlFor="keyboard-menu">
              صفحه
            </label>
            <select
              id="keyboard-menu"
              className="form-control"
              value={menu}
              onChange={(e) => setMenu(e.target.value)}
            >
              {menus.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="muted" style={{ marginBlockEnd: 0 }}>
              {menus.find((m) => m.id === menu)?.hint ?? ''}
            </p>
          </div>
        </div>

        <h4>پیش‌نمایش</h4>
        <p className="muted" style={{ marginBlockStart: 0 }}>
          ردیف‌هایی که از دیتابیس می‌آیند — سرویس‌ها، کانفیگ‌ها، تراکنش‌ها — همیشه بالای این دکمه‌ها
          می‌نشینند و این‌جا دیده نمی‌شوند. دکمه‌های «شرطی» فقط وقتی کشیده می‌شوند که ربات بتواند
          کارشان را انجام دهد؛ وگرنه حذف می‌شوند و جایشان بسته می‌شود.
        </p>
        <ButtonGrid
          rows={boardRows}
          onChange={(next) => {
            // The board IS the arrangement now: a chip's row is its row index
            // and its place in that row is its column. There is no second
            // place for the order to live, so nothing can disagree with it.
            const placed = new Map<string, { rowIndex: number; colIndex: number }>();
            next.forEach((row, r) =>
              row.forEach((chip, c) => placed.set(chip.key, { rowIndex: r, colIndex: c })),
            );
            setButtons((bs) => bs.map((b) => ({ ...b, ...(placed.get(b.action) ?? {}) })));
          }}
          screenText={menus.find((m) => m.id === menu)?.hint ?? ''}
        />
        <p className="muted">{GRID_HELP}</p>

        <h4>دکمه‌ها</h4>
        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>دکمه</th>
                <th>عنوان</th>
                <th>رنگ</th>
                <th>نمایش</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {buttons.map((b) => {
                const info = actions.find((a) => a.action === b.action);
                return (
                  <tr key={b.action}>
                    <td>
                      <div className="ltr">{b.action}</div>
                      <div className="page-head__sub">{info?.hint ?? '—'}</div>
                      {info?.required && <span className="badge">لازم</span>}{' '}
                      {info?.conditional && <span className="badge">شرطی</span>}
                      {info?.placeholders && info.placeholders.length > 0 && (
                        <div className="page-head__sub">
                          عنوانش باید{' '}
                          <span className="ltr">
                            {info.placeholders.map((p) => `{${p}}`).join('، ')}
                          </span>{' '}
                          را داشته باشد.
                        </div>
                      )}
                    </td>
                    <td>
                      <input
                        className="form-control"
                        type="text"
                        maxLength={maxLabel}
                        value={b.label}
                        onChange={(e) => update(b.action, { label: e.target.value })}
                      />
                    </td>
                    <td>
                      <StylePicker
                        value={b.style ?? null}
                        onChange={(style) => update(b.action, { style })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={b.visible}
                        onChange={(e) => update(b.action, { visible: e.target.checked })}
                        {...w}
                      />
                    </td>
                    <td>
                      {/* A required button has no delete: the server refuses the
                          save anyway, and offering the click is a promise the
                          screen cannot keep. */}
                      {!info?.required && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => remove(b.action)}
                          {...w}
                        >
                          حذف
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {missing.length > 0 && (
          <>
            <h4>دکمه‌های اضافه‌نشده</h4>
            <div className="filters">
              {missing.map((a) => (
                <button
                  key={a.action}
                  type="button"
                  className="btn btn-sm"
                  onClick={() => add(a.action)}
                >
                  + {a.label}
                </button>
              ))}
            </div>
          </>
        )}

        <h4>بازگشت به پیش‌فرض</h4>
        <p className="muted" style={{ marginBlockStart: 0 }}>
          چیدمان ذخیره‌شده حذف می‌شود و ربات دوباره چیدمانی را نشان می‌دهد که با خودش می‌آید — پس
          دکمه‌های جدید نسخه‌های بعدی هم به منو اضافه می‌شوند.
        </p>
        <div className="filters">
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || !customised}
            onClick={() => void reset()}
            {...w}
          >
            بازگشت به پیش‌فرض
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The panel's own paint for Telegram's three names.
 *
 * The shade is this panel's, not Telegram's: nothing here can know what a given
 * client draws, and a swatch claiming to be exact would be a promise the bot
 * cannot keep. What it does promise is WHICH of the three.
 */
const STYLE_TOKENS: Record<ButtonStyle, string> = {
  primary: 'var(--accent)',
  success: 'var(--success)',
  danger: 'var(--danger)',
};

const STYLE_LABELS: Record<ButtonStyle, string> = {
  primary: 'آبی',
  success: 'سبز',
  danger: 'قرمز',
};

/** One button's colour, as four chips — the three, and «no colour». */
function StylePicker({
  value,
  onChange,
}: {
  value: ButtonStyle | null;
  onChange: (next: ButtonStyle | null) => void;
}) {
  const w = useAdminWriteProps();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
      {BUTTON_STYLES.map((style) => (
        <button
          key={style}
          type="button"
          className="btn btn-sm"
          aria-pressed={value === style}
          title={`این دکمه ${STYLE_LABELS[style]} شود`}
          // Filled when chosen, outlined when not: three filled swatches side
          // by side say nothing about which one the button is wearing.
          style={
            value === style
              ? { background: STYLE_TOKENS[style], borderColor: STYLE_TOKENS[style], color: '#fff' }
              : { borderColor: STYLE_TOKENS[style], color: STYLE_TOKENS[style] }
          }
          onClick={() => onChange(style)}
          {...w}
        >
          {STYLE_LABELS[style]}
        </button>
      ))}
      <button
        type="button"
        className="btn btn-sm"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        {...w}
      >
        بدون
      </button>
    </div>
  );
}
