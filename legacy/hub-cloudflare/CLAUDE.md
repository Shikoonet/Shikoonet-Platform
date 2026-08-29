# CLAUDE.md — خصوصی، بین Sam و Claude

> این فایل در `.git/info/exclude` است و **هرگز کامیت یا push نمی‌شود**. عمداً در `.gitignore` نیست تا اسمش هم به ادمین نرسد.

> **بازسازی‌شده در ۲۰۲۶-۰۸-۱۲.** نسخهٔ اصلی در یک عملیات جابه‌جایی ناموفق پاک شد و چون git-excluded بود روی ریموت نبود. این متن از روی نسخه‌ای که در همان سشن خوانده شده بود بازنویسی شده و باید کامل باشد — ولی اگر جایی با خاطرت نمی‌خواند، به من بگو.

## قواعد کاری (بالاترین اولویت)

### ۱. چیزی که خصوصی است، خصوصی می‌ماند
این فایل، پلن‌ها، و هر یادداشت کاری بین من و Sam است. فقط **تغییرات کد و فیچرها** به ادمین کل می‌رود. هیچ‌وقت پلن یا یادداشت را کامیت نکن.

### ۲. قبل از هر ارسال به ادمین، گزارش بده
پیش از هر `git push`، هر PR، و هر چیزی که به دست ادمین می‌رسد — **به ترتیب و دقیق** به Sam گزارش بده:

1. چه کامیت‌هایی ساخته شد (SHA + پیام)
2. چه فایل‌هایی عوض شد — `git diff --stat origin/main...HEAD`
3. چه چیزی در ارسال **نیست** چون خصوصی است
4. چه تست‌هایی سبز شد، و روی کدام URL دِو تایید شد
5. متن پیشنهادی PR

**بدون تایید صریح Sam، push نکن.** merge کردن PR کار ادمین است، نه ما.

### ۳. قبل از شروع هر کار، همگام شو
دولوپرهای دیگری هم روی این پروژه کار می‌کنند. اول:

```bash
git fetch --all --tags --prune
git log --oneline HEAD..origin/main
git status --short
```

اگر کامیت جدیدی از دیگران آمده: بخوانش، برای Sam خلاصه کن، و چک کن که آیا `migrations/` فایل جدید گرفته، `wrangler*.toml` عوض شده، یا `pnpm-lock.yaml` تغییر کرده (اگر بله → `pnpm install`). تازه بعدش برنچ بزن.

### ۴. تست‌ها روی WSL اجرا می‌شوند، نه ویندوز

`dashboard-worker` و `ingest-worker` روی ویندوز **هیچ‌وقت** سبز نمی‌شوند. خطا همیشه در teardown است نه assertion:
`@cloudflare/vitest-pool-workers` مطمئن می‌شود هر فایل داخل پوشهٔ persist دیتابیس به `.sqlite` ختم شود، ولی ویندوز فایل `-shm` بازِ در حال حذف را rename می‌کند و یک `<HASH>.SQLITE-SHM.tmp` جا می‌گذارد. باگ بالادستی است، کد ما نیست — patchش نکن.

```bash
wsl -d Ubuntu
cd ~/hub        # همین ریپو، node_modules نصب، node 22 + pnpm 10
pnpm test
```

`~/hubmain` هم کلون `main` است. تایید ۲۰۲۶-۰۸-۱۱ روی `1c93538`: dashboard-worker ۲۳۹/۲۳۹، ingest-worker ۷۶/۷۶.

- `sms-parser`، `domain` و `dashboard-web` روی ویندوز سالم اجرا می‌شوند.
- **هرگز از داخل WSL روی `/mnt/d/...` دستور `pnpm install` نزن** — `node_modules` ویندوز را با باینری لینوکسی خراب می‌کند. برای بردن یک تغییر به WSL فقط همان فایل را کپی کن و بعدش `git checkout --` بزن.
- روی ویندوز `pnpm` روی PATH نیست و `corepack enable` هم EPERM می‌دهد. شیم: یک `pnpm.cmd` در `%TEMP%\pnpmshim\` با محتوای `corepack pnpm %*`، بعد `$env:PATH = "$env:TEMP\pnpmshim;$env:PATH"`.

### ۵. تست زمان‌دار: ساعت را pin کن، تاریخ را hardcode نکن

هر تستی که کدِ زیرش `Date.now()` واقعی را می‌خواند، اگر انتظارش به یک تاریخ ثابت گره بخورد **بمب ساعتی** است — روز نوشته‌شدن سبز است و فردا برای همیشه قرمز. نمونهٔ واقعی: `bot-auto-verified.test.tsx` که `NOW_MS` را روی `2026-08-10` میخ کرده بود و ساعت ۰۰:۰۰ به وقت تهران در ۲۰۲۶-۰۸-۱۱ ترکید.

درستش: `vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)` در `beforeEach` و `vi.restoreAllMocks()` در `afterEach`.

چون این ریپو **هیچ CI ندارد** (`.github/` اصلاً وجود ندارد و «Checks 0» روی PR یعنی هیچ چکی تعریف نشده)، هیچ‌چیز این دسته باگ را نمی‌گیرد. پس هر ادعای «تست سبز» در متن PR باید **تاریخ** داشته باشد.

### ۶. عملیات فایل انبوه روی ویندوز — کپی کن، تایید کن، بعد حذف

**درس ۲۰۲۶-۰۸-۱۲، با هزینهٔ واقعی.** `Move-Item`/`mv` روی پوشه‌های بزرگ این پروژه **نیمه‌کاره تمام می‌شود و در عین حال خطا گزارش می‌کند** — بخشی از فایل‌ها منتقل می‌شوند و بقیه سر جایشان می‌مانند. یک بار `.git` کامل و همهٔ فایل‌های ریشه به همین شکل جابه‌جا شدند و بعد با یک `Remove-Item -Recurse -Force` روی مقصدِ ظاهراً ناموفق، پاک شدند.

قواعد:
- **هرگز `Move-Item`/`mv` روی پوشهٔ بزرگ نزن.** از `robocopy <src> <dst> /E` استفاده کن.
- **قبل از هر `Remove-Item -Recurse`، داخل مقصد را بشمار.** «عملیات خطا داد» یعنی «شاید نصفش انجام شده»، نه «هیچ کاری نشده».
- **اول تایید، بعد حذف منبع.** برای یک ریپو، معیار تایید `git status --short` خالی است.
- **cwd هیچ شلی نباید داخل پوشه‌ای باشد که جابه‌جا می‌شود** — قفل ویندوز از همان‌جا می‌آید.

---

## ابزارها — همیشه فعال

### ۰. این پروژه را از ریشهٔ خودش باز کن
نه از پوشهٔ والد. از والد نه این فایل لود می‌شود و نه هوک‌های graphify شلیک می‌کنند — چون `graphify-out/` را نسبت به cwd می‌گردند.

### graphify — قبل از grep، نه بعدش
قواعد کامل در بخش `## graphify` انتهای همین فایل است (خودِ ابزار می‌نویسدش، دستی ویرایشش نکن). دو نکتهٔ اضافه:

- **strict فعال است:** اولین Read خام هر سشن بلاک می‌شود تا یک `graphify query` اجرا شود. این عمدی است، دورش نزن. فقط اگر گراف واقعاً کهنه بود: `GRAPHIFY_HOOK_STRICT=0`.
- **همین قاعده را در پرامپت هر subagent تکرار کن** — هوک برای ساب‌ایجنت‌ها شلیک نمی‌کند و بیشترین هدررفت توکن همان‌جاست.
- گراف فقط کد است (`--code-only`). `docs/*.md` داخلش نیست — برای آن‌ها مستقیم بخوان.

### ponytail — سطح `full`
سراسری فعال است (پلاگین + SessionStart hook). سادگی پیش‌فرض است، اما در این ریپو **هرگز** ساده نمی‌شوند:
اعتبارسنجی ورودی روی مرز اعتماد · هر مسیر پول · RBAC و Access · و کل بخش «قواعد پروژه که نباید شکسته شوند».

### Playwright MCP — باگ UI را ببین، حدس نزن
هر باگ داشبورد **قبل** از fix با Playwright روی URL دِو بازتولید و **بعد** از fix با همان ابزار تایید شود. استدلال از روی کد به‌تنهایی کافی نیست.

- داشبورد پشت Cloudflare Access است — نشست مرورگر باید احراز هویت شده باشد وگرنه فقط صفحهٔ لاگین را می‌بینی.
- **dev و prod ظاهر یکسان دارند؛ تنها تمایز بج `ENV_NAME` است.** قبل از هر کلیک تخریبی بجّ را بخوان — `payment-hub-staging` دیتای واقعی است.

### پلاگین‌ها
از اسکیل/پلاگین‌های نصب‌شده هر وقت مناسب بود آزادانه استفاده کن. یک استثنا: اسکیل‌های دامنه‌ای این پروژه (`mirzabot-matching`، `mirzabot-card-assignment`، `sms-relay`) انتخابی نیستند — قبل از دست‌زدن به کد مربوطه الزامی‌اند.

---

## فرآیند ریلیز

هیچ چیزی مستقیم به پروداکشن نمی‌رود.

```
برنچ dev/<topic>-<YYYYMMDD>  →  pnpm release:dev  →  PR به main
                                                        ↓
                                            merge ادمین = تایید
                                                        ↓
                                                pnpm release:prod
```

| | dev | production |
|---|---|---|
| داشبورد | `dashboard-worker-dev` | `dashboard-worker` |
| ingest | `ingest-worker-dev` | `ingest-worker` |
| D1 | `payment-hub-dev` | `payment-hub-staging` ← بله، اسمش این است |
| تگ | `v0.2.0-dev.1` | `v0.2.0` |

ورژن در `package.json` ریشه است (تنها منبع معتبر). bump دستی: `npm version <x> --no-git-tag-version`.

---

## دام‌هایی که آسیب می‌زنند

- **`payment-hub-staging` پروداکشن است.** در این ریپو «staging» یعنی production. هر اسکریپتی که فرض کند staging امن است، دیتای واقعی را خراب می‌کند.
- **migrationها خودکار اعمال نمی‌شوند.** `wrangler deploy` آن‌ها را اجرا نمی‌کند. علت ریشه‌ای incident ۵۰۰ در ۲۰۲۶-۰۸-۰۵ همین بود. `release.sh` این قدم را دارد — دور نزن.
- **قبل از هر دیپلوی داشبورد باید `pnpm --filter @hub/dashboard-web build` اجرا شود.** `dist/` در gitignore است و worker آن را mount می‌کند؛ بدون build، باندل کهنه یا خالی می‌رود بالا.
- **dev و prod پشت همان Cloudflare Access و همان باندل SPA هستند.** از روی ظاهر قابل تشخیص نیستند — بج `ENV_NAME` تنها تمایز بصری است.
- **secretها per-worker هستند.** `ingest-worker-dev` کلیدهای خودش را می‌خواهد؛ کلید پروداکشن را کپی نکن.
- **`.production-backups/` و `.deploy-backups/` در گیت کامیت شده‌اند** و شامل export کامل جداول‌اند (متن SMS مشتری‌ها، ایمیل اپراتورها). ریسک PII. پاک‌سازی history تصمیم ادمین است — خودسرانه کاری نکن.

---

## قواعد پروژه که نباید شکسته شوند

اسکیل‌های `.claude/skills/` قواعد دامنه را دارند — **قبل از دست‌زدن به کد مربوطه بخوانشان**:

- `mirzabot-matching` — هر تغییری در `mirzabotMatch.ts`, `mirzabotVerify.ts`, `matching.ts`, یا روت‌های تایید claim
- `mirzabot-card-assignment` — تخصیص کارت در ریپوی PHP میرزابات
- `sms-relay` — قرارداد اپ اندروید

خلاصه‌ی چیزهایی که هرگز نباید بشکنند:
- **اپ اندروید sms-relay دست نمی‌خورد** — نه fork، نه تغییر، نه rebuild.
- **auto-verify فقط برای جفت ایزوله‌ی ۱↔۱**: حساب دقیق، مبلغ دقیق بدون تلورانس، `|bank_timestamp − paid_clicked_at| ≤ 300000ms`. هیچ‌وقت auto-reject نکن، هیچ‌وقت رسید را خودکار fake نزن.
- **یک تراکنش نمی‌تواند چند claim را verify کند** — ایندکس‌های partial unique این را نگه می‌دارند. برای consuming match هرگز `INSERT OR IGNORE` نزن.
- **پول همه‌جا IRR صحیح است** (میرزابات تومان است؛ `amountToman * 10` با یک helper تست‌شده).
- `audit_logs` فقط append است — نه update، نه delete.
- OTP هرگز ذخیره یا رندر نمی‌شود. apiKey و بدنه‌ی خام SMS هرگز لاگ نمی‌شود.
- تغییر شکسته در wire → بامپ `WIRE_VERSION` **و** `/api/v2/...`.

---

## معماری در یک نگاه

مونوریپو pnpm روی Cloudflare Workers + D1. SMS بانکی فارسی از اپ اندروید → `ingest-worker` (پارس، dedupe، تطبیق) → D1 → `dashboard-worker` (Hono + SPA ری‌اکت پشت Access) → وب‌هوک امضاشده به میرزابات برای fulfillment.

- `apps/ingest-worker` — تنها سطح عمومی. `POST /api/v1/sms` با apiKey در بدنه. cron هر ۵ دقیقه برای انقضای claimهای waiting.
- `apps/dashboard-worker` — بک‌اند + میزبان SPA از طریق `[assets]`. همه چیز پشت Access JWT + RBAC.
- `apps/dashboard-web` — React + Vite، بدون router، کش polling دستی در `src/query.ts`.
- `packages/{contracts,database,domain,sms-parser,seed}` — بدون build step، مستقیم از `src/index.ts`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
