/**
 * دسته‌بندی‌ها — the shop's front door, and the row every product needs.
 *
 * This table has been in the schema since migration 0002 with zero rows and no
 * screen: a category could be created from a dropdown inside the service drawer
 * and then never renamed, never switched off, never deleted. Harmless while
 * nothing read the column, and not harmless at all from the day the bot's first
 * screen became this list.
 *
 * WHY CARDS AND NOT A TABLE. A category is four facts — the face it shows in
 * Telegram, how many products it holds, whether it is on sale, and where it
 * sits. A four-column table spends a full row on those four and still makes the
 * button face compete with the count for weight, which is backwards: the face
 * is the thing being designed and the count is context for one decision. The
 * card puts the face first, at roughly the size it is really seen.
 *
 * WHY THE SWITCH AND THE DELETE ARE DIFFERENT BUTTONS. `products.category_id`
 * is NOT NULL with `ON DELETE RESTRICT` since 0032, so a category holding
 * products cannot be deleted — by this route, or by anyone with a psql session.
 * «خاموش» is what an operator actually wants when a line is retired for a
 * month: the products stay put and stop being offered. The count sits on the
 * card so the difference is visible before either is pressed, and delete is
 * only drawn when it can succeed.
 *
 * The panel being replaced has neither. `product.category` there is free text
 * matched to a separate table by string comparison in PHP, and a name with no
 * matching row makes the product invisible in the shop, silently.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type CategoryRow, type PlanRow } from '../api.js';
import { isSellable } from '@shikoo/contracts';
import { count, toman } from '../format.js';
import { useAdminWriteProps } from '../role.js';
import { LayoutEditor } from './LayoutEditor.js';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'duplicate_name') return e.detail ?? 'دسته‌بندی دیگری با این نام هست.';
    if (e.code === 'in_use') return e.detail ?? 'محصولی در این دسته‌بندی هست.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

export function CategoriesPage() {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<CategoryRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<number | null>(null);
  const [arranging, setArranging] = useState(false);
  const [arrangingCategory, setArrangingCategory] = useState<CategoryRow | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      setRows((await api.productCategories()).items);
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function run(job: () => Promise<unknown>) {
    setErr(null);
    try {
      await job();
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  function toggle(r: CategoryRow) {
    if (
      r.active &&
      r.planCount > 0 &&
      !window.confirm(
        `«${r.name}» خاموش شود؟ ${count(r.planCount)} محصول از فروشگاه برداشته می‌شوند. ` +
          'هیچ‌کدام حذف نمی‌شوند — دوباره روشن کنید و برمی‌گردند.',
      )
    ) {
      return;
    }
    void run(() => api.updateCategory(r.id, { active: !r.active }));
  }

  function remove(r: CategoryRow) {
    if (!window.confirm(`«${r.name}» حذف شود؟`)) return;
    void run(() => api.deleteCategory(r.id));
  }

  const products = rows.reduce((n, r) => n + r.planCount, 0);
  const sellable = rows.reduce((n, r) => n + r.sellableCount, 0);
  // What the bot will draw: a category with nothing purchasable in it gets no
  // button at all (`categoriesForUser` joins down to plans and applies
  // `PURCHASABLE`), so this is the real length of the shop's first screen.
  const inShop = rows.filter((r) => r.active && r.sellableCount > 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">دسته‌بندی‌ها</div>
          <div className="page-head__sub">
            {count(inShop.length)} در فروشگاه از {count(rows.length)} · {count(products)} محصول ·{' '}
            <strong className={sellable === 0 ? 'tone-danger' : ''}>
              {count(sellable)} قابل خرید
            </strong>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setArranging((v) => !v)}
          disabled={rows.length === 0}
        >
          {arranging ? 'بستن چیدمان' : 'چیدمان در ربات'}
        </button>
      </div>

      {arranging && (
        <div className="card" style={{ marginBlockEnd: 20 }}>
          <div className="card__head">
            <div className="card__title">صفحهٔ اول فروشگاه</div>
            <div className="page-head__sub">
              دسته‌بندیِ خاموش این‌جا هست و به مشتری نشان داده نمی‌شود
            </div>
          </div>
          <LayoutEditor
            scope="categories"
            screenText="کدام دسته‌بندی؟"
            items={rows.map((r) => ({
              id: r.id,
              label: `${r.emoji ? `${r.emoji} ` : ''}${r.name}`,
              hint: r.active ? `${count(r.sellableCount)} قابل خرید` : 'خاموش',
              rowIndex: r.rowIndex,
            }))}
            onSaved={() => void load()}
          />
        </div>
      )}

      {err && <div className="alert alert-error">{err}</div>}

      {/*
        The whole answer to «دسته‌بندی‌ها اصلا چیکار میکنن؟», in the two states it
        really has. The second one is the important one: the bot skips a
        one-choice screen (`handle.ts:1188`, «a list of one is not a choice»), so
        an admin who built three categories and sees none of them in Telegram is
        looking at correct behaviour with nothing anywhere explaining it. That is
        exactly what happened on 2026-08-27.
      */}
      {!loading && (
        <p className="muted" style={{ marginBlockStart: 0 }}>
          {inShop.length > 1 ? (
            <>
              این همان صفحهٔ اولی است که مشتری بعد از «خرید اشتراک» می‌بیند —{' '}
              {count(inShop.length)} دکمه.
            </>
          ) : inShop.length === 1 ? (
            <>
              فقط «{inShop[0]!.name}» چیز خریدنی دارد، پس ربات این صفحه را رد می‌کند و مشتری
              مستقیم قیمت‌ها را می‌بیند. با دو دسته‌بندیِ خریدنی، صفحه ظاهر می‌شود.
            </>
          ) : (
            <>
              هیچ دسته‌بندی‌ای چیز خریدنی ندارد، پس فروشگاه در ربات خالی است. معمولاً یعنی پنل‌ها
              خاموش‌اند — «محصولات» می‌گوید کدام.
            </>
          )}
        </p>
      )}

      <div className="cat-grid">
        {rows.map((r) =>
          editing === r.id ? (
            <EditCard
              key={r.id}
              row={r}
              onCancel={() => setEditing(null)}
              onSave={(patch) =>
                run(async () => {
                  await api.updateCategory(r.id, patch);
                  setEditing(null);
                })
              }
            />
          ) : (
            <div key={r.id} className={`cat-card${r.active ? '' : ' cat-card--off'}`}>
              <div className="cat-card__face">
                {r.emoji && <span className="cat-card__emoji">{r.emoji}</span>}
                <span>{r.name}</span>
              </div>
              <div className="cat-card__meta">
                <span>
                  {/* Both in the same unit — configs, the thing «محصولات» lists
                      and the bot draws one button per. `productsCount` counts
                      SERVICES and belongs in the two sentences about deleting
                      and switching off, not beside this one. */}
                  {count(r.planCount)} محصول ·{' '}
                  <strong className={r.sellableCount === 0 ? 'tone-danger' : ''}>
                    {count(r.sellableCount)} قابل خرید
                  </strong>
                </span>
                {/* The switch is the operator's decision; the count is the
                    shop's reality. A category can be «در فروشگاه» and draw no
                    button, which is the contradiction this card now shows
                    instead of hiding. */}
                <span className={r.active ? 'badge badge-active' : 'badge badge-block'}>
                  {r.active ? 'در فروشگاه' : 'خاموش'}
                </span>
              </div>
              {r.active && r.sellableCount === 0 && (
                <div className="tone-orange">
                  <strong>در ربات دیده نمی‌شود</strong>
                  <div className="page-head__sub">
                    {r.planCount === 0
                      ? 'محصولی ندارد.'
                      : 'هیچ‌کدام از محصولاتش قابل خرید نیست — معمولاً یعنی پنلشان خاموش است.'}
                  </div>
                </div>
              )}
              <div className="cat-card__actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setEditing(r.id)}
                  {...w}
                >
                  ویرایش
                </button>
                {/* Arranging lives here now, one button per category, because a
                    category IS one screen in the bot. It was on «محصولات»
                    behind a filter and disabled until that filter was set. */}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={r.planCount === 0}
                  title={r.planCount === 0 ? 'محصولی ندارد که چیده شود' : ''}
                  onClick={() => {
                    setArranging(false);
                    setArrangingCategory(arrangingCategory?.id === r.id ? null : r);
                  }}
                >
                  {arrangingCategory?.id === r.id ? 'بستن چیدمان' : 'چیدمان'}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => toggle(r)} {...w}>
                  {r.active ? 'خاموش کن' : 'روشن کن'}
                </button>
                {/* Drawn only when it can succeed. The route and the foreign key
                    both refuse a category holding products, and a button that
                    only ever answers with a refusal reads as broken rather than
                    as a boundary. */}
                {r.productsCount === 0 && (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => remove(r)}
                    {...w}
                  >
                    حذف
                  </button>
                )}
              </div>
            </div>
          ),
        )}

        <NewCard onCreated={() => void load()} nextSort={rows.length} />
      </div>

      {arrangingCategory && (
        <div className="card" style={{ marginBlockStart: 20 }}>
          <div className="card__head">
            <div className="card__title">صفحهٔ «{arrangingCategory.name}» در ربات</div>
            <div className="page-head__sub">
              محصولی که فروخته نمی‌شود این‌جا هست و به مشتری نشان داده نمی‌شود
            </div>
          </div>
          <ArrangeCategory
            category={arrangingCategory}
            onSaved={() => void load()}
          />
        </div>
      )}

      {rows.length === 0 && !loading && (
        <p className="empty">
          هنوز دسته‌بندی‌ای ساخته نشده. تا وقتی دسته‌بندی نباشد سرویسی هم ساخته نمی‌شود، چون هر
          سرویس باید در یکی از این‌ها بنشیند.
        </p>
      )}
    </>
  );
}

/**
 * The arrangement of one category, fetched as its own list.
 *
 * A save has to name the WHOLE screen — the server refuses a partial one,
 * because the rows it was not told about would keep their old positions and
 * interleave — so this asks for every product in the category rather than
 * arranging whatever a filtered table happened to be showing.
 *
 * Moved here from «محصولات» on 2026-08-27. There it lived behind a category
 * filter and its button was disabled until one was chosen, which read as broken.
 * A category is one screen in the bot, so the arrangement belongs on the card
 * for that category and nowhere else.
 */
function ArrangeCategory({ category, onSaved }: { category: CategoryRow; onSaved: () => void }) {
  const [items, setItems] = useState<PlanRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      // One page big enough for a whole category. A shop screen longer than
      // this is refused by `MAX_CATALOG_ROWS` long before it gets here.
      const d = await api.products({ categoryId: category.id, page: 1, pageSize: 100 });
      setItems(d.items);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, [category.id]);

  if (err) return <div className="alert alert-error">{err}</div>;
  if (!items) return <p className="muted">در حال خواندن…</p>;

  return (
    <LayoutEditor
      scope={`category:${category.id}`}
      screenText={`${category.emoji ? `${category.emoji} ` : ''}${category.name} — کدام را می‌خواهید؟`}
      items={items.map((r) => ({
        id: r.id,
        label: r.name,
        // The price, or why a customer will never see this button. The editor
        // draws every row of the screen including the ones the shop is not
        // offering, so saying which is which is the difference between «چیدمان»
        // and a list of things that may or may not exist.
        hint: isSellable({
          planStatus: r.status,
          productStatus: r.product.status,
          panel: r.provider
            ? {
                name: r.provider.name ?? '—',
                status: r.provider.status ?? 'DISABLED',
                capacity: r.provider.capacity,
                liveSubscriptions: r.provider.liveSubscriptions,
              }
            : null,
        })
          ? toman(r.priceIrr)
          : `${toman(r.priceIrr)} · فروخته نمی‌شود`,
        rowIndex: r.rowIndex,
      }))}
      onSaved={() => {
        void load();
        onSaved();
      }}
    />
  );
}

/** The same card, with its two editable fields swapped in where they are read. */
function EditCard({
  row,
  onCancel,
  onSave,
}: {
  row: CategoryRow;
  onCancel: () => void;
  onSave: (patch: { name: string; emoji: string | null }) => void;
}) {
  const w = useAdminWriteProps();
  const [name, setName] = useState(row.name);
  const [emoji, setEmoji] = useState(row.emoji ?? '');

  return (
    <form
      className="cat-card"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ name: name.trim(), emoji: emoji.trim() === '' ? null : emoji.trim() });
      }}
    >
      <div className="cat-card__face" style={{ gap: 6 }}>
        <input
          className="form-control"
          aria-label="ایموجی"
          style={{ width: '3.5rem', textAlign: 'center', padding: '9px 4px' }}
          value={emoji}
          maxLength={16}
          onChange={(e) => setEmoji(e.target.value)}
        />
        <input
          className="form-control"
          aria-label="نام دسته‌بندی"
          value={name}
          maxLength={80}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="cat-card__meta">
        <span>{count(row.planCount)} محصول</span>
      </div>
      <div className="cat-card__actions">
        <button type="submit" className="btn btn-sm btn-primary" disabled={name.trim() === ''} {...w}>
          ذخیره
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          انصراف
        </button>
      </div>
    </form>
  );
}

/**
 * The last card in the grid, rather than a form above it.
 *
 * A category is made the same shape it is read, in the place the next one would
 * appear — which is also what stops the empty state from being a table with
 * nothing in it and a form floating over the top.
 */
function NewCard({ onCreated, nextSort }: { onCreated: () => void; nextSort: number }) {
  const w = useAdminWriteProps();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="cat-card cat-card--new" onClick={() => setOpen(true)} {...w}>
        <span className="cat-card__emoji">＋</span>
        <span>دسته‌بندی تازه</span>
      </button>
    );
  }

  return (
    <form
      className="cat-card cat-card--new"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() === '') return;
        setBusy(true);
        setErr(null);
        void api
          .createCategory({
            name: name.trim(),
            emoji: emoji.trim() === '' ? null : emoji.trim(),
            // Last, so a new category does not push itself in front of the shop.
            sortOrder: nextSort,
          })
          .then(() => {
            setName('');
            setEmoji('');
            setOpen(false);
            onCreated();
          })
          .catch((e2: unknown) => setErr(message(e2)))
          .finally(() => setBusy(false));
      }}
    >
      <div className="cat-card__face" style={{ gap: 6 }}>
        <input
          className="form-control"
          aria-label="ایموجی"
          style={{ width: '3.5rem', textAlign: 'center', padding: '9px 4px' }}
          value={emoji}
          maxLength={16}
          placeholder="🇩🇪"
          onChange={(e) => setEmoji(e.target.value)}
        />
        <input
          className="form-control"
          aria-label="نام دسته‌بندی"
          value={name}
          maxLength={80}
          autoFocus
          placeholder="سرویس‌های اروپا"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {err && <div className="alert alert-error">{err}</div>}
      <div className="cat-card__actions">
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={busy || name.trim() === ''}
          {...w}
        >
          بساز
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
          انصراف
        </button>
      </div>
    </form>
  );
}
