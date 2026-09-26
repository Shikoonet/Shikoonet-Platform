-- 0105_support_answers_are_rows_in_the_panel.sql — Sam, 2026-09-26.
--
-- The support bot's question-and-answer list. Until now it was a block of
-- text inside the n8n workflow's prompt, so adding one answer meant editing
-- the workflow. Sam's condition for the support bot was that the list stays
-- open to additions: an answer is a row, typed in «محتوا» → «پرسش و پاسخ
-- پشتیبانی», and the support door (`/kb`) hands the visible rows to the bot
-- on every customer message.
--
-- `active` is what the door filters on, so hiding an answer is the reversible
-- step and a delete is refused while it is visible, as for «آموزش».
-- `version` counts edits; each edit's before and after text is in audit_logs
-- (SUPPORT_ANSWER), which is where an older wording is read back from.
--
-- The rows below are the ten answers the bot has used since 2026-09-25,
-- word for word. «تست رایگان دارید؟» is not among them: it tells the bot to
-- call a tool, which is a rule of the prompt rather than an answer.
--
-- Undo: DROP TABLE support_answers;

BEGIN;

CREATE TABLE support_answers (
  id          bigint  PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  question    text    NOT NULL CHECK (length(btrim(question)) BETWEEN 1 AND 300),
  answer      text    NOT NULL CHECK (length(btrim(answer)) BETWEEN 1 AND 1500),
  sort_order  integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 9999),
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO support_answers (question, answer, sort_order) VALUES
  ('چطور سرویس بخرم؟ قیمت‌ها چنده؟',
   'در ربات فروشگاه، فهرست به‌روز قیمت‌ها در «📋 تعرفه سرویس‌ها» است. برای خرید «🔐 خرید اشتراک» را بزنید و لوکیشن و پلن را انتخاب کنید. بعد از پرداخت و تأیید، لینک اشتراک همان‌جا در ربات برایتان ارسال می‌شود.',
   10),
  ('چطور پرداخت کنم؟',
   'کارت‌به‌کارت معمولی (نه پایا/ساتنا) به کارتی که در فاکتور آمده، دقیقاً با همان مبلغ فاکتور. در توضیحات واریز کلمهٔ VPN ننویسید. فقط تا ساعتی که روی فاکتور نوشته شده به آن کارت واریز کنید. بعد از واریز «پرداخت کردم» را بزنید و عکس رسید را در ربات بفرستید.',
   20),
  ('پرداخت کردم، چرا سرویس نیامد؟',
   'بعد از «پرداخت کردم» باید عکس رسید را در همان ربات بفرستید؛ بدون رسید سرویس ارسال نمی‌شود، حتی وقتی واریزی شما پیدا شده باشد. تأیید معمولاً چند دقیقه طول می‌کشد و پرداختتان محفوظ است. اگر بیشتر طول کشید، شمارهٔ پیگیری را بفرستید تا همکارم بررسی کند.',
   30),
  ('مهلت فاکتور تمام شد، چکار کنم؟',
   'به کارت آن فاکتور دیگر واریز نکنید. از «🔐 خرید اشتراک» یک فاکتور تازه بگیرید. اگر قبل از پایان مهلت واریز کرده‌اید و «پرداخت کردم» را زده‌اید، پرداختتان در صف بررسی است و گم نمی‌شود.',
   40),
  ('لینک را کجا وارد کنم؟ چطور وصل شوم؟',
   'لینک اشتراکی را که ربات فرستاده در برنامهٔ مخصوص دستگاهتان وارد کنید. فهرست برنامه‌ها و آموزش هر دستگاه در ربات، بخش «📚 آموزش» است.',
   50),
  ('وصل نمی‌شود / قطع شدم',
   'اول در «🛍 سرویس های من» وضعیت سرویس را ببینید. اگر نوشته «تاریخ انقضا گذشته» یا «حجم تمام شده»، باید تمدید کنید. اگر فعال است، در برنامه اشتراک را آپدیت کنید و یک سرور دیگر را امتحان کنید. اگر باز وصل نشد، نام سرویس را بفرستید تا همکارم بررسی کند.',
   60),
  ('چطور تمدید کنم؟',
   'از «♻️ تمدید سرویس» در ربات، سرویس و بعد پلن را انتخاب کنید. ربات قبل از پرداخت می‌گوید زمان و حجم به باقی‌مانده اضافه می‌شود یا از نو شروع می‌شود. لینک اشتراکتان عوض نمی‌شود. اگر سرویستان در فهرست تمدید نیست، همکارم بررسی می‌کند.',
   70),
  ('کیف پول چیست و چطور شارژش کنم؟',
   'از «🏦 کیف پول + شارژ» مبلغ را انتخاب کنید و مثل خرید، کارت‌به‌کارت کنید و رسید بفرستید. بعد از آن خرید و تمدید را می‌توانید بدون کارت‌به‌کارت، از موجودی کیف پول بپردازید.',
   80),
  ('زیرمجموعه‌گیری چطور کار می‌کند؟',
   'در «👥 زیر مجموعه گیری» لینک دعوت اختصاصی شما هست. از خرید کسانی که با لینک شما وارد ربات می‌شوند، پورسانت به کیف پولتان اضافه می‌شود. درصد دقیق و درآمدتان تا امروز در همان صفحه نوشته شده.',
   90),
  ('سرورهاتون کدوم کشورهاست؟',
   'سرویس‌ها چندلوکیشنی هستند و سرورهای آلمان، فنلاند، ترکیه، ایتالیا، آمریکا و فرانسه را دارند. فهرست گاهی عوض می‌شود؛ برای دیدن آخرین فهرست، لینک اشتراک را در برنامه آپدیت کنید.',
   100);

COMMIT;
