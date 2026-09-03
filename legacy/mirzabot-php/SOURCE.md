# مرجعِ میرزابات — از کجا آمده و چرا این‌جاست

`src/` یک clone از آپ‌استریمِ میرزابات است، برای **خواندن**. کد زنده‌ای از آن نمی‌آید.

| | |
|---|---|
| remote | `https://github.com/mahdiMGF2/mirzabot` |
| HEAD موقع clone | `ae4891a` — «emoji handling functions to improve clarity and functionality»، ۲۰۲۶-۰۹-۰۲ |
| تاریخ clone | ۲۰۲۶-۰۹-۰۳ |

## در گیتِ این ریپو نیست، عمداً

`legacy/` از ۲۰۲۶-۰۸-۲۹ tracked است، ولی این پوشه `.git` خودش را دارد و گیت ریپوی
تودرتو را به‌صورت gitlink ثبت می‌کند — همان چیزی که CLAUDE.md می‌گوید روی گیت‌هاب یک
پوشهٔ خالیِ کلیک‌ناپذیر می‌شود. پس فعلاً در `.git/info/exclude` است (محلی، نه در
`.gitignore` مشترک). اگر Sam بخواهد vendor شود، راهش همان است که برای سه پوشهٔ دیگر
انجام شد: `.git` به `.notes/legacy-git/` منتقل شود و بعد کامیت.

## نسخهٔ پایه برای diff

ربات زندهٔ Sam فورک همین است و روی این ماشین، بیرون از ریپو:

    ~/Documents/mydev/.mirzabot-backup-20260811T135834Z   fork Isusami/mirzabot, HEAD 684ed07
    ~/Documents/mydev/shikoxima                           فورک شخصی، یک کامیت «init»
    ~/Documents/mydev/faoxima                             ربات مقایسه‌ای

«آپ‌استریم چه چیزی اضافه کرده» یک دستور است، نه حدس:

    git -C legacy/mirzabot-php/src log 684ed07..main --oneline

## چه چیزی از آن برداشته شد

- **ایموجی پریمیوم روی دکمه** (`botapi.php:53` `applyCustomEmojiToMarkup`) — تگِ ابتدای
  برچسب جدا می‌شود و id آن در `icon_custom_emoji_id` خود دکمه می‌نشیند، روی هر دو
  `inline_keyboard` و `keyboard`. این ایده برداشته شد.
- **سرعت پیام همگانی** — برداشته **نشد**، چون چیزی برای برداشتن نبود:
  `cronbot/sendmessage.php` هنوز ۲۰تا در هر تیک می‌فرستد و `activecron()` در
  `function.php:1734` آن را `*/1` صدا می‌زند → ۱٬۲۰۰ در ساعت. در کل ریپویشان یک
  `curl_multi` هم نیست.
