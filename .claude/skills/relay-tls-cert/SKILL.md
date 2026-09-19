---
name: relay-tls-cert
description: TLS certificates for the SMS-relay ingest hosts (sms.chopon.uk, sms-dev.chopon.uk) — why they use Google Trust Services via the `gts` Traefik resolver instead of Let's Encrypt (Android 7 relay phone lacks ISRG Root X1), how to verify a cert against the phone's root store, the acme.json gotcha, the 2028-01-28 expiry of this workaround, and rollback. Use before touching the ingest apps' Traefik labels, Coolify proxy config, or anything that could reissue their certificates.
---

# گواهی TLS اپ‌های ingest — GTS، نه Let's Encrypt

منبع: بند «قواعدی که نباید بشکنند» در `CLAUDE.md` تا ۲۰۲۶-۰۹-۱۹؛ همان روز به این‌جا منتقل شد
تا در هر سشن بار نشود. متن دست‌نخورده است.

**گواهی `sms.chopon.uk` و `sms-dev.chopon.uk` از Google Trust Services است، نه Let's Encrypt — ۲۰۲۶-۰۹-۱۷.**
گوشیِ رله اندروید ۷.۰ است و `ISRG Root X1` را ندارد (از ۷.۱.۱ آمد)؛ cross-sign قدیمی LE هم
۲۰۲۴-۰۹-۳۰ مرده. پس هر گواهی LE روی این دو دامنه با «Trust anchor for certification path not
found» رد می‌شود — زنجیره کامل است، ریشه در گوشی نیست. با root store واقعی `android-7.0.0_r1`
از AOSP سنجیده شد: LE → خطای ۲۰، GTS (`GTS Root R1 ⟵ GlobalSign Root CA`) → ok.

پیاده‌سازی: در Coolify › Proxy › Configuration یک resolver دوم به نام `gts` (ACME گوگل + EAB،
پروژهٔ GCP `shikoo-ca` — پاکش نکن، اکانت ACME به آن گره خورده)، و روی دو اپ ingest «Label
management → Managed manually» با `tls.certresolver=gts`. فقط این دو اپ؛ داشبورد و ربات روی LE
می‌مانند. تمدید خودکار است (۹۰ روزه، ۳۰ روز مانده)؛ کلید EAB یک‌بارمصرف بود و دیگر لازم نیست.

**گیری که نیم ساعت گرفت:** Traefik تا وقتی `acme.json` گواهی LE همان دامنه را دارد از resolver
جدید چیزی نمی‌خواهد — همهٔ storeها را نگاه می‌کند، نه فقط مال خودش. باید ورودی دامنه از
`/traefik/acme.json` حذف و پروکسی ری‌استارت شود (بکاپ در `/traefik/backups/acme.json.pre-gts*`).
ری‌استارت پروکسی چند ثانیه همهٔ اپ‌های سرور را قطع می‌کند.

چک، همیشه با root store گوشی نه با لپ‌تاپ:
```bash
openssl s_client -connect sms.chopon.uk:443 -servername sms.chopon.uk -showcerts </dev/null 2>/dev/null \
  | grep -E '^ [0-9] s:|^   i:'          # آخرین i: باید CN=GlobalSign Root CA باشد
```
مدرک نهایی فقط لاگ خود اپ روی گوشی است: `200` بعد از یک SMS واقعی.

**این راه‌حل ۲۰۲۸-۰۱-۲۸ تمام می‌شود** — cross-sign گلوبال‌ساین منقضی می‌شود و هیچ CA عمومی‌ای
به این گوشی نمی‌رسد. بعد از آن: گوشی نو، یا rebuild اپ با Network Security Config
(`targetSdk 35` است، CA نصب‌شده توسط کاربر را نادیده می‌گیرد). بازگشت: لیبل → `letsencrypt`،
Redeploy، ری‌استارت پروکسی.