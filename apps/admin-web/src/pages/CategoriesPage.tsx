/**
 * دسته‌بندی‌ها — the shop's first screen, and the row every product needs.
 *
 * This table was in the schema from 0002 and had zero rows and no screen: a
 * category could be created from a dropdown inside the service drawer and then
 * never touched again. It matters now because the bot's first screen IS this
 * list — «خرید اشتراک» draws a button per row here — so the thing that used to
 * be an unused label is what a customer sees before anything else.
 *
 * WHY THERE IS A SWITCH AND A DELETE, AND THEY ARE NOT THE SAME BUTTON.
 * `products.category_id` is NOT NULL with `ON DELETE RESTRICT` since 0032, so a
 * category holding products cannot be deleted at all — by the route, and by
 * anybody with a psql session. «خاموش» is what an operator actually wants when
 * a line is retired for a month: the products stay where they are and stop
 * being offered. The count sits next to both, before either is pressed, because
 * «۷ محصول» is the difference between the two decisions.
 *
 * The panel this replaces has neither. `product.category` there is free text
 * matched to a `category` table by string comparison in PHP, and typing a name
 * with no matching row makes the product invisible in the shop with nothing
 * anywhere saying so.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type CategoryRow } from '../api.js';
import { count } from '../format.js';
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
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ name: string; emoji: string }>({ name: '', emoji: '' });
  const [newName, setNewName] = useState('');
  const [newEmoji, setNewEmoji] = useState('');
  const [arranging, setArranging] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const d = await api.productCategories();
      setRows(d.items);
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

  async function create() {
    if (newName.trim() === '') return;
    await run(async () => {
      await api.createCategory({
        name: newName.trim(),
        emoji: newEmoji.trim() === '' ? null : newEmoji.trim(),
        // Last, so a new category does not push itself in front of the shop.
        sortOrder: rows.reduce((max, r) => Math.max(max, r.sortOrder), -1) + 1,
      });
      setNewName('');
      setNewEmoji('');
    });
  }

  function toggle(r: CategoryRow) {
    if (
      r.active &&
      r.productsCount > 0 &&
      !window.confirm(
        `«${r.name}» خاموش شود؟ ${count(r.productsCount)} محصول از فروشگاه برداشته می‌شوند و ` +
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

  const total = rows.reduce((n, r) => n + r.productsCount, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">دسته‌بندی‌ها</div>
          <div className="page-head__sub">
            {count(rows.length)} دسته‌بندی · {count(total)} محصول
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setArranging((v) => !v)}
          disabled={rows.length === 0}
        >
          {arranging ? 'بستن چیدمان' : 'چیدمان صفحهٔ اول ربات'}
        </button>
      </div>

      {arranging && (
        <div className="card">
          <h4>چیدمان صفحهٔ اول ربات</h4>
          <LayoutEditor
            scope="categories"
            note={
              'این همان صفحه‌ای است که مشتری بعد از «خرید اشتراک» می‌بیند. دسته‌بندیِ خاموش و ' +
              'دسته‌بندی‌ای که هیچ محصول خریدنی ندارد این‌جا هست ولی به مشتری نشان داده نمی‌شود — ' +
              'ردیفش بسته می‌شود و بقیه سرِ جایشان می‌مانند.'
            }
            items={rows.map((r) => ({
              id: r.id,
              label: `${r.emoji ? `${r.emoji} ` : ''}${r.name}`,
              hint: r.active ? `${count(r.productsCount)} محصول` : 'خاموش',
              rowIndex: r.rowIndex,
            }))}
            onSaved={() => void load()}
          />
        </div>
      )}

      <div className="card">
        {err && <div className="alert alert-error">{err}</div>}

        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div>
            <label className="form-label" htmlFor="cat-emoji">
              ایموجی
            </label>
            <input
              id="cat-emoji"
              className="form-control"
              style={{ width: '5rem', textAlign: 'center' }}
              value={newEmoji}
              maxLength={16}
              onChange={(e) => setNewEmoji(e.target.value)}
              placeholder="🇩🇪"
            />
          </div>
          <div className="grow">
            <label className="form-label" htmlFor="cat-name">
              دسته‌بندی تازه
            </label>
            <input
              id="cat-name"
              className="form-control"
              value={newName}
              maxLength={80}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="مثلاً: سرویس‌های اروپا"
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading || newName.trim() === ''}
            {...w}
          >
            افزودن
          </button>
        </form>

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>دکمه در ربات</th>
                <th>محصول</th>
                <th>وضعیت</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={4}>
                    هنوز دسته‌بندی‌ای ساخته نشده. تا وقتی دسته‌بندی نباشد محصولی هم ساخته نمی‌شود.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {editing === r.id ? (
                      <div className="filters" style={{ marginBlock: 0 }}>
                        <input
                          className="form-control"
                          style={{ width: '5rem', textAlign: 'center' }}
                          value={draft.emoji}
                          maxLength={16}
                          onChange={(e) => setDraft({ ...draft, emoji: e.target.value })}
                        />
                        <input
                          className="form-control grow"
                          value={draft.name}
                          maxLength={80}
                          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        />
                      </div>
                    ) : (
                      <span className="preview-button" style={{ display: 'inline-block' }}>
                        {r.emoji ? `${r.emoji} ` : ''}
                        {r.name}
                      </span>
                    )}
                  </td>
                  <td>{count(r.productsCount)}</td>
                  <td>
                    <span className={r.active ? 'badge badge-active' : 'badge badge-block'}>
                      {r.active ? 'در فروشگاه' : 'خاموش'}
                    </span>
                  </td>
                  <td>
                    {editing === r.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() =>
                            void run(async () => {
                              await api.updateCategory(r.id, {
                                name: draft.name.trim(),
                                emoji: draft.emoji.trim() === '' ? null : draft.emoji.trim(),
                              });
                              setEditing(null);
                            })
                          }
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
                            setEditing(r.id);
                            setDraft({ name: r.name, emoji: r.emoji ?? '' });
                          }}
                          {...w}
                        >
                          ویرایش
                        </button>{' '}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => toggle(r)}
                          {...w}
                        >
                          {r.active ? 'خاموش کن' : 'روشن کن'}
                        </button>{' '}
                        {/* Offered only when it can succeed. The route and the
                            foreign key both refuse a category with products,
                            and a button that always answers with a refusal
                            reads as broken rather than as a boundary. */}
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
