/**
 * A section that has a place in the navigation and no screen behind it.
 *
 * It says so plainly rather than showing an empty table that looks like "no
 * data". Those are opposite facts and an admin acting on the wrong one wastes
 * an afternoon.
 *
 * The two sections left are not merely unbuilt — they have nowhere to read
 * from. `settings` holds switches like `text_edit` and `status_keyboard_config`,
 * but the bot's message texts and its keyboard layout are not rows anywhere:
 * there is no table for them in Postgres, and no source table in the production
 * MySQL either (checked 2026-08-14 — `SHOW TABLES` has no `textbot` and no
 * keyboard table; the texts live in the PHP source). Faoxima's `textbot.php`
 * edits tables this shop has never had.
 *
 * So they need a versioned migration and bot support before a screen means
 * anything, and this page says that instead of promising a table that does not
 * exist.
 */

import { pageLabel, type PageId } from '../nav.js';

const BLOCKED: Partial<Record<PageId, string>> = {
  texts:
    'متن‌های ربات هنوز جایی برای خوانده‌شدن ندارند: نه جدولی در Postgres هست و نه در دامپ MySQL پروداکشن — متن‌ها داخل سورس PHP نوشته شده‌اند. این بخش اول یک مهاجرت نسخه‌دار و پشتیبانی سمت ربات می‌خواهد.',
  keyboard:
    'چیدمان کیبورد هم جدولی ندارد. در `settings` فقط کلیدهای سوییچ مثل `status_keyboard_config` هست، نه خودِ چیدمان. مثل متن‌ها، اول مهاجرت لازم است.',
};

export function NotBuiltPage({ id }: { id: PageId }) {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">{pageLabel(id)}</div>
          <div className="page-head__sub">این بخش هنوز ساخته نشده است</div>
        </div>
      </div>
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          {BLOCKED[id] ??
            'این بخش هنوز صفحه‌ای ندارد. ترتیب ساخت در docs/admin-panel-roadmap.md نوشته شده.'}
        </p>
      </div>
    </>
  );
}
