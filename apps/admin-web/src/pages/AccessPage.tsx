/**
 * دسترسی‌ها — who may operate the shop, on both surfaces.
 *
 * Two tables that look alike and are not: `access_users` decides what a
 * signed-in operator may do **in this panel**, and `admins` decides who may use
 * the **bot's** admin screens and what they may decide there. Neither is a login
 * — the panel's door is a Cloudflare Access policy configured elsewhere, and the
 * bot's is a Telegram id. The page says so, because an admin who believes they
 * granted access and did not is worse off than one who knows there is a second
 * step.
 *
 * Every refusal here is the server's own sentence. The guards live inside the
 * UPDATE and the DELETE — "you do not demote yourself", "the last active admin
 * stays" — so this screen never predicts them, it reports them.
 */

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type AccessUserRow,
  type BotAdminRoleName,
  type BotAdminRow,
  type PanelRole,
  type PermissionInfo,
} from '../api.js';
import { count } from '../format.js';

const PANEL_ROLE_FA: Record<PanelRole, string> = {
  ADMIN: 'ادمین',
  REVIEWER: 'بازبین',
  READ_ONLY: 'فقط خواندن',
};

const BOT_ROLE_FA: Record<BotAdminRoleName, string> = {
  OWNER: 'مالک',
  ADMIN: 'ادمین',
  SUPPORT: 'پشتیبان',
};

const PANEL_ROLES = Object.keys(PANEL_ROLE_FA) as PanelRole[];
const BOT_ROLES = Object.keys(BOT_ROLE_FA) as BotAdminRoleName[];

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

export function AccessPage({ role }: { role: PanelRole | null }) {
  // The panel used to draw every button for everybody and let the server answer
  // 403. Safe, and it reads as a broken panel rather than as a boundary.
  const canWrite = role === 'ADMIN';

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">دسترسی‌ها</div>
          <div className="page-head__sub">
            نقش شما: {role === null ? '…' : PANEL_ROLE_FA[role]}
          </div>
        </div>
      </div>

      {!canWrite && (
        <div className="alert alert-info">
          این صفحه برای شما فقط‌خواندنی است. تغییر دسترسی‌ها کار ادمین است.
        </div>
      )}

      <PanelOperators canWrite={canWrite} />
      <BotOperators canWrite={canWrite} />
    </>
  );
}

function PanelOperators({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<AccessUserRow[]>([]);
  const [you, setYou] = useState('');
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<PanelRole>('REVIEWER');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try {
      const d = await api.accessUsers();
      setRows(d.items);
      setYou(d.you);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card__head">
        <span className="card__title">کاربران پنل</span>
      </div>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        این فهرست تعیین می‌کند هر کسی که وارد پنل می‌شود چه کاری می‌تواند بکند.{' '}
        <strong>اجازهٔ ورود</strong> از Cloudflare Access می‌آید و جای دیگری تنظیم می‌شود — افزودن
        ردیف این‌جا کسی را وارد نمی‌کند.
      </p>

      {err && <div className="alert alert-error">{err}</div>}

      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>ایمیل</th>
              <th>نقش</th>
              <th>وضعیت</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="empty" colSpan={canWrite ? 4 : 3}>
                  هنوز کسی اضافه نشده است.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const mine = r.email === you;
              return (
                <tr key={r.id}>
                  <td className="ltr">
                    {r.email}
                    {mine && <span className="badge">خودتان</span>}
                  </td>
                  <td>
                    {canWrite && !mine ? (
                      <select
                        className="form-control"
                        value={r.role}
                        disabled={busy}
                        aria-label={`نقش ${r.email}`}
                        onChange={(e) =>
                          void act(() => api.updateAccessUser(r.id, { role: e.target.value as PanelRole }))
                        }
                      >
                        {PANEL_ROLES.map((x) => (
                          <option key={x} value={x}>
                            {PANEL_ROLE_FA[x]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      PANEL_ROLE_FA[r.role]
                    )}
                  </td>
                  <td>
                    <span className={r.active ? 'badge badge-active' : 'badge badge-block'}>
                      {r.active ? 'فعال' : 'غیرفعال'}
                    </span>
                  </td>
                  {canWrite && (
                    <td>
                      {!mine && (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() =>
                              void act(() => api.updateAccessUser(r.id, { active: !r.active }))
                            }
                          >
                            {r.active ? 'غیرفعال' : 'فعال'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => void act(() => api.deleteAccessUser(r.id))}
                          >
                            حذف
                          </button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canWrite && (
        <div className="filters">
          <div className="grow">
            <label className="form-label" htmlFor="au-email">
              ایمیل
            </label>
            <input
              id="au-email"
              className="form-control ltr"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="au-role">
              نقش
            </label>
            <select
              id="au-role"
              className="form-control"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as PanelRole)}
            >
              {PANEL_ROLES.map((x) => (
                <option key={x} value={x}>
                  {PANEL_ROLE_FA[x]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || email.trim() === ''}
            onClick={() =>
              void act(async () => {
                await api.createAccessUser({ email: email.trim(), role: newRole });
                setEmail('');
              })
            }
          >
            افزودن
          </button>
        </div>
      )}
    </div>
  );
}

function BotOperators({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<BotAdminRow[]>([]);
  const [perms, setPerms] = useState<PermissionInfo[]>([]);
  const [telegramId, setTelegramId] = useState('');
  const [username, setUsername] = useState('');
  const [newRole, setNewRole] = useState<BotAdminRoleName>('SUPPORT');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try {
      const d = await api.botAdmins();
      setRows(d.items);
      setPerms(d.permissions);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  /** Toggling writes the explicit value, so it survives a later role change. */
  function toggle(row: BotAdminRow, key: string, on: boolean) {
    return act(() =>
      api.updateBotAdmin(row.id, { permissions: { ...row.permissions, [key]: on } }),
    );
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">ادمین‌های ربات</span>
      </div>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        این‌ها با شناسهٔ تلگرام وارد پنل ربات می‌شوند. تیک‌ها همان کارهایی است که کد واقعاً بررسی
        می‌کند — چیزی که در فهرست نیست، محدود نمی‌شود. مالک همیشه همه را دارد.
      </p>

      {err && <div className="alert alert-error">{err}</div>}

      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>شناسهٔ تلگرام</th>
              <th>نقش</th>
              <th>دسترسی‌ها</th>
              <th>وضعیت</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="empty" colSpan={canWrite ? 5 : 4}>
                  هیچ ادمینی برای ربات ثبت نشده است — یعنی پنل ادمین ربات برای کسی باز نمی‌شود.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="ltr">
                  {r.telegramId}
                  {r.username && <div className="page-head__sub">{r.username}</div>}
                </td>
                <td>
                  {canWrite ? (
                    <select
                      className="form-control"
                      value={r.role}
                      disabled={busy}
                      aria-label={`نقش ${r.telegramId}`}
                      onChange={(e) =>
                        void act(() =>
                          api.updateBotAdmin(r.id, { role: e.target.value as BotAdminRoleName }),
                        )
                      }
                    >
                      {BOT_ROLES.map((x) => (
                        <option key={x} value={x}>
                          {BOT_ROLE_FA[x]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    BOT_ROLE_FA[r.role]
                  )}
                </td>
                <td>
                  {perms.map((p) => (
                    <label key={p.key} className="muted" style={{ display: 'block' }}>
                      <input
                        type="checkbox"
                        checked={r.effective.includes(p.key)}
                        disabled={busy || !canWrite || r.role === 'OWNER'}
                        onChange={(e) => void toggle(r, p.key, e.target.checked)}
                      />{' '}
                      {p.label}
                    </label>
                  ))}
                </td>
                <td>
                  <span className={r.active ? 'badge badge-active' : 'badge badge-block'}>
                    {r.active ? 'فعال' : 'غیرفعال'}
                  </span>
                  {r.decisionsCount > 0 && (
                    <div className="page-head__sub">{count(r.decisionsCount)} تصمیم نمایندگی</div>
                  )}
                </td>
                {canWrite && (
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void act(() => api.updateBotAdmin(r.id, { active: !r.active }))}
                    >
                      {r.active ? 'غیرفعال' : 'فعال'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void act(() => api.deleteBotAdmin(r.id))}
                    >
                      حذف
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canWrite && (
        <div className="filters">
          <div>
            <label className="form-label" htmlFor="ba-tg">
              شناسهٔ تلگرام
            </label>
            <input
              id="ba-tg"
              className="form-control ltr"
              type="number"
              value={telegramId}
              onChange={(e) => setTelegramId(e.target.value)}
            />
          </div>
          <div className="grow">
            <label className="form-label" htmlFor="ba-user">
              نام کاربری (اختیاری)
            </label>
            <input
              id="ba-user"
              className="form-control ltr"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label className="form-label" htmlFor="ba-role">
              نقش
            </label>
            <select
              id="ba-role"
              className="form-control"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as BotAdminRoleName)}
            >
              {BOT_ROLES.map((x) => (
                <option key={x} value={x}>
                  {BOT_ROLE_FA[x]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || telegramId.trim() === ''}
            onClick={() =>
              void act(async () => {
                await api.createBotAdmin({
                  telegramId: Number(telegramId),
                  username: username.trim() === '' ? null : username.trim(),
                  role: newRole,
                });
                setTelegramId('');
                setUsername('');
              })
            }
          >
            افزودن
          </button>
        </div>
      )}
    </div>
  );
}
