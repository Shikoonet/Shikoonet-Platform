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
import { MAX_CATALOG_ROWS } from '@shikoo/contracts';
import {
  api,
  ApiError,
  type ButtonStyle,
  type CategoryRow,
  type ServiceRow,
} from '../api.js';
import { count, STATUS_FA } from '../format.js';
import { useAdminWriteProps } from '../role.js';
import { LayoutEditor } from './LayoutEditor.js';
import { BadgeField, badgeValue } from './BadgeField.js';

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
  const [arrangingTiers, setArrangingTiers] = useState<number | null>(null);

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
              label: `${r.badge ? `${r.badge} ` : ''}${r.name}`,
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
      {/*
        `err === null` on both this sentence and the empty state below.
        A failed load leaves `rows` empty, and an empty `rows` used to be read as
        a fact about the shop: on 2026-08-27 a 500 from this route rendered as
        «هیچ دسته‌بندی‌ای چیز خریدنی ندارد» AND «هنوز دسته‌بندی‌ای ساخته نشده»,
        two confident claims produced by knowing nothing at all. When the answer
        did not arrive, the only honest thing on screen is the error.
      */}
      {!loading && err === null && (
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
                {r.badge && <span className="cat-card__emoji">{r.badge}</span>}
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
              {arrangingTiers === r.id && (
                <ArrangeTiers category={r} onSaved={() => void load()} />
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
                <button type="button" className="btn btn-sm" onClick={() => toggle(r)} {...w}>
                  {r.active ? 'خاموش کن' : 'روشن کن'}
                </button>
                {/* The screen THIS category opens, which is a different screen
                    from the one the header arranges. One service is not a
                    choice — the bot skips straight past it to the prices — so
                    there is nothing to arrange until there are two. */}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={r.productsCount < 2}
                  title={
                    r.productsCount < 2
                      ? 'با یک سرویس، ربات این صفحه را رد می‌کند'
                      : `چیدمان سرویس‌های «${r.name}» در ربات`
                  }
                  onClick={() => setArrangingTiers(arrangingTiers === r.id ? null : r.id)}
                  {...w}
                >
                  {arrangingTiers === r.id ? 'بستن چیدمان' : 'چیدمان سرویس‌ها'}
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

      {rows.length === 0 && !loading && err === null && (
        <p className="empty">
          هنوز دسته‌بندی‌ای ساخته نشده. تا وقتی دسته‌بندی نباشد سرویسی هم ساخته نمی‌شود، چون هر
          سرویس باید در یکی از این‌ها بنشیند.
        </p>
      )}
    </>
  );
}

/**
 * Arranging a category's PRICES used to live here, and moved to «سرویس‌ها» on
 * 2026-08-27, because the screen it edited had stopped existing: a category
 * lists SERVICES, and prices are one step further in. Arranging a whole
 * category put two configs from two services on «the same row» of a screen
 * where they never appear together.
 *
 * What arranges from this page now is two screens, and they are easy to
 * confuse — so they are named after what the customer pressed to get there:
 *
 *   header «چیدمان در ربات»  → the category list, what «خرید اشتراک» opens
 *   card   «چیدمان سرویس‌ها»  → THIS category's tiers, what pressing it opens
 *
 * The second is the one below, and it is new on 2026-08-28: until `products`
 * had a `row_index` (0037) the tier screen was the only catalogue keyboard that
 * could not be arranged, and on the live shop four tiers came out as four rows
 * of one between two screens that both put two buttons on a line.
 */

/**
 * The tier screen of one category.
 *
 * Fetches on open rather than with the page: an operator arranges one category
 * at a time, and the card list would otherwise pull every service in the shop
 * to draw counts it already has.
 */
function ArrangeTiers({ category, onSaved }: { category: CategoryRow; onSaved: () => void }) {
  const [services, setServices] = useState<ServiceRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .catalog({ categoryId: category.id, pageSize: MAX_CATALOG_ROWS })
      .then((r) => live && setServices(r.items))
      .catch((e: unknown) => live && setErr(message(e)));
    return () => {
      live = false;
    };
  }, [category.id]);

  if (err !== null) return <div className="alert alert-error">{err}</div>;
  if (services === null) return <p className="muted">…</p>;

  return (
    <LayoutEditor
      scope={`category:${category.id}`}
      screenText={`یکی از گزینه‌های «${category.name}» را انتخاب کنید.`}
      items={services.map((s) => ({
        id: s.id,
        label: s.name,
        // What a customer would meet behind this button, and why they might
        // not: the editor draws every service, including the ones the shop is
        // not offering. Said in configs because that is the unit the next
        // screen is measured in.
        hint:
          s.status === 'ACTIVE'
            ? `${count(s.configs.length)} کانفیگ`
            : `${count(s.configs.length)} کانفیگ · ${STATUS_FA[s.status] ?? s.status}`,
        rowIndex: s.rowIndex,
      }))}
      onSaved={onSaved}
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
  onSave: (patch: { name: string; badge: string | null; buttonStyle: ButtonStyle | null }) => void;
}) {
  const w = useAdminWriteProps();
  const [name, setName] = useState(row.name);
  const [badge, setBadge] = useState(row.badge ?? '');
  const [buttonStyle, setButtonStyle] = useState(row.buttonStyle);

  return (
    <form
      className="cat-card"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ name: name.trim(), badge: badgeValue(badge), buttonStyle });
      }}
    >
      <div className="cat-card__face">
        <input
          className="form-control"
          aria-label="نام دسته‌بندی"
          value={name}
          maxLength={80}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <BadgeField
        id={`cat-badge-${row.id}`}
        value={badge}
        onChange={setBadge}
        style={buttonStyle}
        onStyleChange={setButtonStyle}
        preview={`${badge.trim() === '' ? '' : `${badge.trim()} `}${name.trim() || row.name}`}
      />
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
  const [badge, setBadge] = useState('');
  const [buttonStyle, setButtonStyle] = useState<ButtonStyle | null>(null);
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
            badge: badgeValue(badge),
            buttonStyle,
            // Last, so a new category does not push itself in front of the shop.
            sortOrder: nextSort,
          })
          .then(() => {
            setName('');
            setBadge('');
            setButtonStyle(null);
            setOpen(false);
            onCreated();
          })
          .catch((e2: unknown) => setErr(message(e2)))
          .finally(() => setBusy(false));
      }}
    >
      <div className="cat-card__face">
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
      <BadgeField
        id="cat-badge-new"
        value={badge}
        onChange={setBadge}
        style={buttonStyle}
        onStyleChange={setButtonStyle}
        preview={`${badge.trim() === '' ? '' : `${badge.trim()} `}${name.trim() || 'سرویس‌های اروپا'}`}
      />
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
