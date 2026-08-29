"""Text templates for admin channel_lock."""


def main_menu_text(channel_count: int) -> str:
    return f"🔐 قفل چنل‌ها\n\n• تعداد کانال‌های قفل: {channel_count}\n\nیکی از گزینه‌های زیر را انتخاب کنید:"


LIST_EMPTY_TEXT = "📋 لیست کانال‌های قفل\n\n❌ هیچ کانالی ثبت نشده است."


def list_text(channel_count: int) -> str:
    return f"📋 لیست کانال‌های قفل\n\n• تعداد کانال‌ها: {channel_count}"


def channel_detail_text(channel_info: dict) -> str:
    return (
        f"🧊 جزئیات کانال قفل\n\n"
        f"• آیدی: `{channel_info['id']}`\n"
        f"• عنوان: {channel_info['title']}\n"
        f"• لینک: {channel_info['link']}\n\n"
        f"از دکمه‌های زیر برای مدیریت استفاده کن:"
    )


EDIT_LINK_PROMPT = "✏️ تغییر لینک کانال\n\nلطفاً لینک جدید کانال را ارسال کنید:"
EDIT_TITLE_PROMPT = "✏️ تغییر عنوان کانال\n\nلطفاً عنوان جدید کانال را ارسال کنید:"


def delete_confirm_text(channel_info: dict) -> str:
    return (
        f"⚠️ تایید حذف کانال\n\n"
        f"• عنوان: {channel_info['title']}\n"
        f"• آیدی: `{channel_info['id']}`\n\n"
        f"آیا مطمئن هستید که می‌خواهید این کانال را حذف کنید؟"
    )


ADD_CHANNEL_INSTRUCTIONS = (
    "🧊 افزودن کانال (قفل چنل‌ها)\n\n"
    "یکی از این موارد رو ارسال کن:\n"
    "• لینک پابلیک (https://t.me/username) یا @username\n"
    "• لینک یک پست از کانال پرایوت (https://t.me/c/.../...)\n"
    "• یا یک پیام از همون کانال رو Forward کن\n"
    "• یا آیدی عددی (-100...)"
)

CHANNEL_NOT_FOUND_ALERT = "❌ کانال یافت نشد!"
DELETE_SUCCESS_ALERT = "✅ کانال با موفقیت حذف شد!"

FORWARD_NOT_CHANNEL = (
    "❌ پیام فوروارد شده از یک کانال نیست!\n\n"
    "لطفاً یکی از این روش‌ها را امتحان کنید:\n"
    "• لینک پابلیک (https://t.me/username)\n"
    "• لینک یک پست از کانال (https://t.me/c/.../...)\n"
    "• آیدی عددی کانال (-100...)"
)

SEND_INPUT_REQUIRED = "❌ لطفاً یکی از موارد درخواستی را ارسال کنید!"


def bot_no_access_text(access_error: str, *, private_hint: bool = False) -> str:
    text = (
        f"❌ ربات دسترسی به کانال ندارد!\n"
        f"خطا: {access_error}\n\n"
        f"لطفاً مطمئن شوید که ربات در کانال عضو است و دسترسی ادمین دارد."
    )
    if private_hint:
        text += "\n\n💡 نکته: برای کانال‌های پرایوت، بهتر است از لینک پیام (t.me/c/.../...) استفاده کنید."
    return text


def invite_link_error_text(invite_error: str) -> str:
    return (
        f"❌ خطا در ساخت لینک دعوت!\n"
        f"خطا: {invite_error}\n\n"
        f"💡 راه حل:\n"
        f"• مطمئن شوید ربات در کانال عضو است\n"
        f"• مطمئن شوید ربات دسترسی ادمین دارد\n"
        f"• مطمئن شوید ربات دسترسی ساخت لینک دعوت دارد\n\n"
        f"یا از لینک پیام کانال استفاده کنید: t.me/c/.../..."
    )


def invite_link_error_simple_text(invite_error: str) -> str:
    return f"❌ خطا در ساخت لینک دعوت!\nخطا: {invite_error}\n\nلطفاً مطمئن شوید که ربات دسترسی ساخت لینک دعوت دارد."


def forward_process_error_text(error: Exception) -> str:
    return (
        f"❌ خطا در پردازش پیام فوروارد شده: {error!s}\n\n"
        f"💡 راه حل: برای کانال‌های پرایوت، از لینک پیام استفاده کنید:\n"
        f"• کپی لینک یکی از پست‌های کانال (t.me/c/.../...)\n"
        f"• یا آیدی عددی کانال (-100...)"
    )


def channel_resolve_error_text(error: Exception) -> str:
    return f"❌ خطا در دریافت اطلاعات کانال: {error!s}"


def invite_link_warning_text(invite_error: str, current_link: str) -> str:
    return f"⚠️ هشدار: نتوانستیم لینک دعوت بسازیم.\nخطا: {invite_error}\n\nلینک فعلی: {current_link}"


def add_channel_success_text(channel_info: dict) -> str:
    return (
        f"✅ کانال با موفقیت اضافه شد!\n\n"
        f"🧊 جزئیات کانال قفل\n\n"
        f"• آیدی: `{channel_info['id']}`\n"
        f"• عنوان: {channel_info['title']}\n"
        f"• لینک: {channel_info['link']}\n\n"
        f"از دکمه‌های زیر برای مدیریت استفاده کن:"
    )


def save_channel_error_text(error: Exception) -> str:
    return f"❌ خطا در ذخیره کانال: {error!s}"


def channel_not_found_text(error_display: str) -> str:
    return (
        f"❌ نتوانستیم کانال را پیدا کنیم!\n\n"
        f"خطا: {error_display}\n\n"
        f"لطفاً مطمئن شوید که:\n"
        f"• لینک یا آیدی صحیح است\n"
        f"• ربات در کانال عضو است\n"
        f"• ربات دسترسی ادمین دارد"
    )


def edit_link_success_text(channel_id, title: str, link: str) -> str:
    return (
        f"🧊 جزئیات کانال قفل\n\n"
        f"• آیدی: `{int(channel_id)}`\n"
        f"• عنوان: {title}\n"
        f"• لینک: {link}\n\n"
        f"✅ لینک کانال با موفقیت به‌روزرسانی شد!\n\n"
        f"از دکمه‌های زیر برای مدیریت استفاده کن:"
    )


def edit_title_success_text(channel_id, title: str, link: str) -> str:
    return (
        f"🧊 جزئیات کانال قفل\n\n"
        f"• آیدی: `{int(channel_id)}`\n"
        f"• عنوان: {title}\n"
        f"• لینک: {link}\n\n"
        f"✅ عنوان کانال با موفقیت به‌روزرسانی شد!\n\n"
        f"از دکمه‌های زیر برای مدیریت استفاده کن:"
    )


EDIT_CHANNEL_INFO_NOT_FOUND = "❌ خطا: اطلاعات کانال یافت نشد."
EDIT_CHANNEL_ID_NOT_FOUND = "❌ خطا: شناسه کانال یافت نشد."

LEGACY_ENTER_CHANNEL_ID = "لطفاً ایدی عددی کانال خود را وارد کنید:"
LEGACY_ENTER_CHANNEL_LINK = "لطفاً لینک کانال خود را وارد کنید:"
LEGACY_ENTER_CHANNEL_TITLE = "لطفاً عنوان کانال را وارد کنید:"
LEGACY_ENTER_NEW_LINK = "لینک جدید را وارد کنید:"
LEGACY_CHANNEL_UPDATED = "کانال بروزرسانی شد."


def legacy_channel_added_text(channel_id, channel_link, channel_name) -> str:
    return (
        "کانال با موفقیت اضافه یا به‌روزرسانی شد!\n"
        f"ایدی کانال: {channel_id}\n"
        f"لینک کانال: {channel_link}\n"
        f"عنوان کانال: {channel_name}\n"
    )


DEFAULT_CHANNEL_TITLE = "کانال بدون عنوان"
PRIVATE_CHANNEL_TITLE = "کانال خصوصی"


def auto_removed_channel_text(channel_id, existing_channel: dict) -> str:
    return (
        f"🚨 **حذف خودکار کانال قفل**\n\n"
        f"ربات از کانال زیر حذف شد و به صورت خودکار از لیست قفل چنل‌ها حذف گردید:\n\n"
        f"• آیدی: `{channel_id}`\n"
        f"• عنوان: `{existing_channel.get('title')}`\n"
        f"• لینک: {existing_channel.get('link')}"
    )
