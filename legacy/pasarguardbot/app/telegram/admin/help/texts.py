"""Text templates for admin help download management."""

from app.telegram.keyboards.registry import STYLE_LABELS

UPDATE_APPS_MESSAGE = "🈸 آپدیت برنامه ها"

ACCESS_DENIED_TEXT = "❌ دسترسی ندارید"
APP_NOT_FOUND_TEXT = "❌ اپ یافت نشد."
NOT_FOUND_TEXT = "❌ یافت نشد."
SAVE_ERROR_TEXT = "❌ خطا در ذخیره."
DELETE_ERROR_TEXT = "خطا در حذف."
DUPLICATE_KEY_ERROR_TEXT = "❌ خطا در ذخیره. احتمالاً کلید تکراری است."

APPS_LIST_TEXT = (
    "📦 **اپ‌های دانلود**\n\n"
    "روی هر اپ → تنظیمات + **📥 دکمه‌های دانلود (الگو)** برای `%` نسخه.\n"
    "مثال الگو: `v2rayNG_%.%.%_universal.apk`"
)

APPS_MANAGE_TITLE = "📦 **مدیریت اپ‌های دانلود**"
APPS_MANAGE_CANCELLED_TEXT = f"{APPS_MANAGE_TITLE}\n\nانصراف داده شد."

ADD_GITHUB_APP_STEP1_TEXT = (
    "📦 **افزودن اپ دانلودی**\n\n**مرحله ۱/۴**\nنام دکمه را بفرستید (مثلاً `Hiddify` یا `V2rayNG`):"
)
ADD_TEXT_ONLY_STEP1_TEXT = (
    "📝 **افزودن متن/لینک (بدون گیت‌هاب)**\n\n**مرحله ۱/۲**\nنام دکمه را بفرستید (مثلاً `FairVPN در اپ استور`):"
)
ADD_TEXT_ONLY_STEP2_TEXT = "**مرحله ۲/۲**\nمتن یا لینکی که با کلیک کاربر نمایش داده شود را بفرستید:"
ADD_GITHUB_STEP2_TEXT = "**مرحله ۲/۴**\nمخزن گیت‌هاب را بفرستید (فرمت: `owner/repo`)"
ADD_GITHUB_STEP3_TEXT = "**مرحله ۳/۴**\nدسته‌بندی فایل‌ها را انتخاب کنید:"
ADD_GITHUB_STEP4_TEXT = (
    "**مرحله ۴/۴**\nلینک اپ استور برای iOS (اختیاری).\n\nدکمه «بدون لینک iOS» بزنید یا در چت لینک را بفرستید:"
)

SET_ICON_PROMPT_TEXT = "📎 آیدی سند ایموجی پریمیوم را بفرستید یا /skip برای حذف:"
EDIT_BUTTON_TEXT_PROMPT = "✏️ متن جدید دکمه را ارسال کنید:"
EDIT_REPO_PROMPT = "✏️ مخزن گیت‌هاب را بفرستید (فرمت: owner/repo):"
EDIT_IOS_PROMPT = "✏️ لینک اپ استور iOS را بفرستید یا - برای حذف:"
EDIT_CUSTOM_MSG_PROMPT = "✏️ متن پیام (یا لینک) را بفرستید:"
ADD_TARGET_TEXT_PROMPT = "➕ **افزودن دکمه دانلود**\n\nمتن دکمه را بفرستید (مثلاً `اندروید` یا `اندروید بتا`):"
SET_TARGET_ICON_PROMPT = "📎 آیدی سند ایموجی را بفرستید:"

INVALID_REPO_FORMAT_TEXT = "❌ فرمت نامعتبر. مثال: owner/repo"
INVALID_REPO_FORMAT_EXAMPLE_TEXT = "❌ فرمت نامعتبر. مثال: `owner/repo`"
MIN_PATTERN_REQUIRED_TEXT = "❌ حداقل یک الگو لازم است."
INVALID_ICON_TEXT = "❌ آیکون معتبر نیست."
INVALID_PREMIUM_EMOJI_TEXT = (
    "❌ ایموجی معمولی document_id ندارد. از پنل ایموجی‌های پریمیوم تلگرام بفرستید، "
    "یا آیدی عددی/فرمت `emoji/ID` را ارسال کنید. برای حذف هم /skip را بفرستید."
)

UPDATE_APPS_STATUS_TEXT = "🔄 در حال بروزرسانی فایل‌های برنامه‌ها..."
ICON_CLEARED_TEXT = "آیکون دکمه حذف شد."
ICON_SET_TEXT = "✅ آیکون تنظیم شد."
BUTTON_TEXT_UPDATED_TEXT = "✅ متن دکمه به‌روزرسانی شد."
REPO_UPDATED_TEXT = "✅ مخزن به‌روزرسانی شد."
IOS_UPDATED_TEXT = "✅ لینک iOS به‌روزرسانی شد."
CUSTOM_MSG_UPDATED_TEXT = "✅ متن پیام به‌روزرسانی شد."
TARGET_ADDED_TEXT = "✅ دکمه اضافه شد."
TARGET_DELETED_TEXT = "حذف شد."
APP_DELETED_TEXT = "حذف شد."
TARGET_ICON_CLEARED_TEXT = "آیکون حذف شد."
BUTTON_STYLE_CLEARED_TEXT = "رنگ دکمه حذف شد."
MIGRATE_OK_TEXT = "✅ تبدیل شد."
MIGRATE_SKIP_TEXT = "قبلاً تنظیم شده یا categories خالی است."

ADD_TARGET_PATTERNS_TEXT = (
    "📄 **الگوهای فایل** را بفرستید (هر خط یک الگو):\n\nمثال:\n`v2rayNG_%.%.%_universal.apk`\n`v2rayNG_%.%.%_x86.apk`"
)

NO_BUTTON_STYLE_LABEL = "بدون رنگ"


def app_config_text(button_text: str) -> str:
    return f"📝 **{button_text}**\n\nهمهٔ مقادیر این اپ را می‌توانید تغییر دهید."


def defaults_added_text(added: int) -> str:
    return f"{APPS_MANAGE_TITLE}\n\n✅ **{added}** اپ پیش‌فرض اضافه شد."


def app_added_text(button_text: str) -> str:
    return f"{APPS_MANAGE_TITLE}\n\n✅ اپ **{button_text}** اضافه شد."


def text_only_added_text(button_text: str) -> str:
    return f"✅ متن/لینک **{button_text}** اضافه شد."


def github_app_added_text(button_text: str, callback_key: str) -> str:
    return f"✅ اپ **{button_text}** اضافه شد.\nکلید دکمه: `Download_{callback_key}`"


def button_style_changed_text(style_val: str) -> str:
    return f"رنگ تغییر کرد به {STYLE_LABELS.get(style_val, style_val)}."


def target_color_changed_text(style_val: str) -> str:
    label = NO_BUTTON_STYLE_LABEL if style_val == "none" else STYLE_LABELS.get(style_val, style_val)
    return f"✅ رنگ: {label}"


def icon_set_with_config_text(button_text: str) -> str:
    return f"{ICON_SET_TEXT}\n\n📝 **{button_text}**"


def target_edit_text(target: dict) -> str:
    pats = "\n".join(f"• `{p}`" for p in (target.get("patterns") or [])) or "—"
    style = (target.get("button_style") or "").strip()
    style_label = STYLE_LABELS.get(style, style) if style else NO_BUTTON_STYLE_LABEL
    return f"✏️ **{target.get('button_text', '')}**\n\n🎨 رنگ دکمه: **{style_label}**\n\nالگوها:\n{pats}"
