"""Text templates for admin log management."""

from app.telegram.admin.logs import states

LOG_ENTRY_MESSAGE = "📝 مدیریت لاگ‌ها"

LOG_TYPE_LABELS = dict(states.ALL_LOG_TYPES)


def log_type_label(log_type: str) -> str:
    if log_type == states.SET_ALL_LOG_TYPE:
        return "همه لاگ‌ها"
    return LOG_TYPE_LABELS.get(log_type, log_type)


LOG_MANAGEMENT_TEXT = (
    "📝 **مدیریت لاگ‌ها**\n\n"
    "از این بخش می‌توانید کانال‌ها و گروه‌های مقصد برای ارسال لاگ‌ها را تنظیم کنید.\n\n"
    "برای تنظیم سریع همه لاگ‌ها با یک آیدی، از گزینه **⚡ ست همه لاگ‌ها با یک آیدی** استفاده کنید."
)

SET_ALL_DESTINATION_TEXT = (
    "⚡ **ست همه لاگ‌ها با یک آیدی**\n\n"
    "با این گزینه یک مقصد برای **همه** انواع لاگ تنظیم می‌شود.\n"
    "لطفاً نوع مقصد را انتخاب کنید:"
)


def destination_menu_text(log_type: str) -> str:
    label = log_type_label(log_type)
    return f"**{label}**\n\nلطفاً نوع مقصد را انتخاب کنید:"


EMPTY_LOG_STATUS_TEXT = "📊 **وضعیت لاگ‌ها**\n\n❌ هیچ لاگی تنظیم نشده است."
LOG_STATUS_HEADER = "📊 **وضعیت لاگ‌ها**\n\n"
INVALID_NUMERIC_ID_TEXT = "❌ لطفاً آیدی عددی معتبر ارسال کنید!"
INVALID_GROUP_OR_TOPIC_TEXT = (
    "❌ لطفاً یکی از موارد زیر را ارسال کنید:\n\n"
    "• لینک یک پیام از تایپک (مثل: https://t.me/c/3210435570/2/10122)\n"
    "• آیدی عددی گروه (مثل: -1001234567890)"
)
INVALID_TOPIC_TEXT = (
    "❌ لطفاً یکی از موارد زیر را ارسال کنید:\n\n"
    "• لینک یک پیام از تایپک (مثل: https://t.me/c/3210435570/2/10122)\n"
    "• آیدی عددی تایپک"
)
MISSING_CHAT_ID_TEXT = "❌ خطا: آیدی گروه یافت نشد. لطفاً دوباره شروع کنید."


def channel_setup_text(log_type: str) -> str:
    label = log_type_label(log_type)
    if log_type == states.SET_ALL_LOG_TYPE:
        return (
            f"📢 **تنظیم کانال برای {label}**\n\n"
            "لطفاً آیدی عددی کانال را ارسال کنید.\n"
            "این آیدی برای **همه** انواع لاگ ذخیره می‌شود.\n\n"
            "⚠️ **نکته:** آیدی کانال معمولاً با علامت منفی شروع می‌شود (مثل: -1001234567890)"
        )
    return (
        f"📢 **تنظیم کانال برای {label}**\n\n"
        "لطفاً آیدی عددی کانال را ارسال کنید.\n\n"
        "⚠️ **نکته:** آیدی کانال معمولاً با علامت منفی شروع می‌شود (مثل: -1001234567890)"
    )


def supergroup_setup_text(log_type: str) -> str:
    label = log_type_label(log_type)
    if log_type == states.SET_ALL_LOG_TYPE:
        return (
            f"👥 **تنظیم سوپرگروه با تایپک برای {label}**\n\n"
            "لطفاً آیدی عددی گروه یا لینک پیام تایپک را ارسال کنید.\n"
            "این مقصد برای **همه** انواع لاگ ذخیره می‌شود.\n\n"
            "⚠️ **نکته:** آیدی گروه معمولاً با علامت منفی شروع می‌شود (مثل: -1001234567890)"
        )
    return (
        f"👥 **تنظیم سوپرگروه با تایپک برای {label}**\n\n"
        "لطفاً آیدی عددی گروه را ارسال کنید.\n\n"
        "⚠️ **نکته:** آیدی گروه معمولاً با علامت منفی شروع می‌شود (مثل: -1001234567890)"
    )


def status_line(log) -> str:
    label = log_type_label(log.log_type)
    if log.is_active:
        if log.topic_id:
            return f"✅ **{label}**: سوپرگروه `{log.chat_id}` (تایپک: `{log.topic_id}`)\n"
        return f"✅ **{label}**: کانال `{log.chat_id}`\n"
    return f"❌ **{label}**: غیرفعال\n"


def test_success_text(log_type: str) -> str:
    label = log_type_label(log_type)
    return f"✅ لاگ {label} با موفقیت ست شد!\n\nاین پیام تست است."


def test_all_success_text() -> str:
    return "✅ **همه لاگ‌ها** با موفقیت ست شدند!\n\nاین پیام تست است."


def channel_configured_text(log_type: str, chat_id: int) -> str:
    label = log_type_label(log_type)
    if log_type == states.SET_ALL_LOG_TYPE:
        return f"✅ کانال برای **همه لاگ‌ها** با موفقیت تنظیم شد!\nآیدی کانال: `{chat_id}`\n\nپیام تست ارسال شد."
    return f"✅ کانال لاگ {label} با موفقیت تنظیم شد!\nآیدی کانال: `{chat_id}`\n\nپیام تست ارسال شد."


def channel_test_error_text(error: Exception) -> str:
    return f"❌ خطا در ارسال پیام تست به کانال!\nلطفاً مطمئن شوید که ربات در کانال عضو است.\n\nخطا: {error!s}"


def supergroup_configured_text(log_type: str, chat_id, topic_id) -> str:
    label = log_type_label(log_type)
    if log_type == states.SET_ALL_LOG_TYPE:
        return (
            f"✅ سوپرگروه برای **همه لاگ‌ها** با موفقیت تنظیم شد!\n"
            f"آیدی گروه: `{chat_id}`\n"
            f"آیدی تایپک: `{topic_id}`\n\n"
            "پیام تست ارسال شد."
        )
    return (
        f"✅ سوپرگروه لاگ {label} با موفقیت تنظیم شد!\n"
        f"آیدی گروه: `{chat_id}`\n"
        f"آیدی تایپک: `{topic_id}`\n\n"
        "پیام تست ارسال شد."
    )


def supergroup_configured_warning_text(log_type: str, chat_id, topic_id, error: Exception) -> str:
    label = log_type_label(log_type)
    if log_type == states.SET_ALL_LOG_TYPE:
        return (
            f"✅ سوپرگروه برای **همه لاگ‌ها** با موفقیت تنظیم شد!\n"
            f"آیدی گروه: `{chat_id}`\n"
            f"آیدی تایپک: `{topic_id}`\n\n"
            f"⚠️ خطا در ارسال پیام تست: {error!s}"
        )
    return (
        f"✅ سوپرگروه لاگ {label} با موفقیت تنظیم شد!\n"
        f"آیدی گروه: `{chat_id}`\n"
        f"آیدی تایپک: `{topic_id}`\n\n"
        f"⚠️ خطا در ارسال پیام تست: {error!s}"
    )


def log_setup_error_text(error: Exception) -> str:
    return f"❌ خطا در تنظیم لاگ!\nلطفاً مطمئن شوید که ربات در گروه عضو است و تایپک درست است.\n\nخطا: {error!s}"


def topic_prompt_text(log_type: str) -> str:
    label = log_type_label(log_type)
    extra = "\nاین تایپک برای **همه** انواع لاگ ذخیره می‌شود." if log_type == states.SET_ALL_LOG_TYPE else ""
    return (
        f"👥 **تنظیم تایپک برای {label}**\n\n"
        f"حالا آیدی عددی تایپک را ارسال کنید.{extra}\n\n"
        "⚠️ **نکته:** می‌توانید لینک یک پیام از تایپک را ارسال کنید یا آیدی عددی تایپک را."
    )


def topic_test_fallback_text(topic_id, log_type: str) -> str:
    label = log_type_label(log_type)
    if log_type == states.SET_ALL_LOG_TYPE:
        return f"📌 **تایپک: {topic_id}**\n\n✅ **همه لاگ‌ها** با موفقیت ست شدند!\n\nاین پیام تست است."
    return f"📌 **تایپک: {topic_id}**\n\n✅ لاگ {label} با موفقیت ست شد!\n\nاین پیام تست است."
