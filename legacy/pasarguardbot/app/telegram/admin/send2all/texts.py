"""Text templates and helpers for admin send2all."""

from app.services.broadcast.payload_format import format_label
from app.services.telegram.rich_message import RICH_MESSAGE_DOCS_URL

MODE_NAMES_EMOJI = {
    "active": "👥 کاربران فعال",
    "users_with_active_service": "💎 مشتریان (دارای کانفیگ)",
    "reseller_users": "🏢 نمایندگی‌ها",
    "blocked_users": "🚫 بلاک کننده‌ها",
    "banned_users": "🔒 بن شده‌ها",
}

MODE_NAMES_SETTINGS = {
    "active": "👥 کاربران فعال",
    "users_with_active_service": "💎 همگانی به مشتریان دارای کانفیگ",
    "reseller_users": "🏢 همگانی به نمایندگی‌ها",
    "blocked_users": "🚫 کاربران بلاک کننده",
    "banned_users": "🔒 کاربران بن شده",
}

MODE_NAMES_PLAIN = {
    "active": "کاربران فعال",
    "users_with_active_service": "مشتریان دارای کانفیگ فعال",
    "reseller_users": "کاربران دارای نمایندگی",
    "blocked_users": "کاربران بلاک کرده",
    "banned_users": "کاربران بن شده",
}

STATUS_NAMES = {
    "draft": "📝 پیش‌نویس",
    "pending_confirm": "⏳ در انتظار تایید",
    "queued": "📋 در صف ارسال",
    "running": "🔄 در حال اجرا",
    "paused": "⏸️ متوقف شده",
    "failed": "❌ ناموفق",
}

BROADCAST_DELAYS_MS = [0, 100, 200, 300, 500, 1000, 2000]
BROADCAST_BATCH_SIZES = [10, 20, 30, 50, 100, 200]
BROADCAST_BATCH_DELAYS_MS = [0, 1000, 2000, 3000, 5000, 10000]

SEND_IN_PROGRESS_TEXT = "⏳ یه ارسال همگانی در جریانه. لطفاً صبر کنید تا تموم بشه!"
FORWARD_IN_PROGRESS_TEXT = "⏳ یه فوروارد همگانی در جریانه. لطفاً صبر کنید تا تموم بشه!"
CANCELLED_TO_PANEL_TEXT = "✅ لغو شد و به پنل بازگشتید."
ALBUM_COLLECT_ERROR_TEXT = "❌ خطا در جمع‌آوری آلبوم. لطفاً دوباره تلاش کنید."
JOB_CREATE_ERROR_TEXT = "❌ خطا در ایجاد کار ارسال همگانی!"
NO_TARGETS_TEXT = "❌ هیچ کاربری برای ارسال پیام پیدا نشد."
JOB_FETCH_ERROR_TEXT = "❌ خطا در دریافت اطلاعات کار!"
SETTINGS_USE_BUTTONS_TEXT = "⚠️ لطفاً از دکمه‌های تنظیمات استفاده کنید."
CREATE_NEW_PROMPT_TEXT = (
    "➕ پیام متنی یا مدیا را ارسال کنید.\n"
    f"برای نوع **Rich** از [راهنمای فرمت تلگرام]({RICH_MESSAGE_DOCS_URL}) استفاده کنید.\n"
    "نوع پیام (عادی / Rich) را از **⚙️ تنظیمات** انتخاب کنید."
)
MENU_BACK_TEXT = "🔙 بازگشت به منو"

FORMAT_SELECTION_TEXT = "📝 **نوع پیام:**\n\nگزینه مورد نظر را انتخاب کنید:"
DELAY_SELECTION_TEXT = "⏱️ **انتخاب تاخیر بین پیام‌ها:**\n\nگزینه مورد نظر را انتخاب کنید:"
BATCH_SELECTION_TEXT = "📦 **انتخاب اندازه دسته:**\n\nگزینه مورد نظر را انتخاب کنید:"
MODE_SELECTION_TEXT = "🎯 **انتخاب حالت ارسال:**\n\nگزینه مورد نظر را انتخاب کنید:"
BATCH_DELAY_SELECTION_TEXT = "⏸️ **انتخاب تاخیر بین دسته‌ها:**\n\nگزینه مورد نظر را انتخاب کنید:"


def calculate_estimated_time(total_users: int, delay_ms: int, batch_size: int, batch_delay_ms: int) -> int:
    if total_users == 0:
        return 0

    time_per_user = delay_ms / 1000.0
    num_batches = (total_users + batch_size - 1) // batch_size
    time_for_messages = total_users * time_per_user
    time_for_batch_delays = (num_batches - 1) * (batch_delay_ms / 1000.0) if num_batches > 1 else 0

    return int(time_for_messages + time_for_batch_delays)


def format_duration(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds} ثانیه"
    if seconds < 3600:
        minutes = seconds // 60
        secs = seconds % 60
        if secs == 0:
            return f"{minutes} دقیقه"
        return f"{minutes} دقیقه و {secs} ثانیه"
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    if minutes == 0 and secs == 0:
        return f"{hours} ساعت"
    if secs == 0:
        return f"{hours} ساعت و {minutes} دقیقه"
    return f"{hours} ساعت و {minutes} دقیقه و {secs} ثانیه"


def format_batch_delay(batch_delay_ms: int) -> str:
    return f"{batch_delay_ms / 1000:.1f}s" if batch_delay_ms > 0 else "0s"


def format_floodwait_time(floodwait_time: float) -> str:
    if floodwait_time <= 0:
        return "0 ثانیه"
    if floodwait_time < 60:
        return f"{floodwait_time:.0f} ثانیه"
    if floodwait_time < 3600:
        return f"{floodwait_time / 60:.1f} دقیقه ({floodwait_time:.0f} ثانیه)"
    hours = floodwait_time / 3600
    return f"{hours:.1f} ساعت ({floodwait_time:.0f} ثانیه)"


def active_broadcast_info_text(
    *,
    admin_mention: str,
    mode_name: str,
    progress: float,
    sent: int,
    total: int,
    sent_ok: int,
    sent_fail: int,
    queue_count: int,
    broadcast_label: str,
) -> str:
    info_text = (
        f"⏳ **یک {broadcast_label} در حال اجراست!**\n\n"
        f"👤 **ایجاد شده توسط:** {admin_mention}\n"
        f"🎯 **حالت:** {mode_name}\n"
        f"📊 **پیشرفت:** {progress:.1f}% ({sent}/{total})\n"
        f"✅ **موفق:** {sent_ok}\n"
        f"❌ **ناموفق:** {sent_fail}\n"
    )
    if queue_count > 0:
        info_text += f"\n📋 **در صف:** {queue_count} همگانی\n"
    info_text += "\n\n**انتخاب کنید:**"
    return info_text


def broadcast_menu_text(title: str) -> str:
    return f"{title}\n\nیکی از گزینه‌های زیر را انتخاب کنید:"


def preview_text(
    *,
    is_forward: bool,
    target_count: int,
    mode_name: str,
    delay_ms: int,
    batch_size: int,
    batch_delay_str: str,
    estimated_time_str: str,
    format_name: str | None = None,
) -> str:
    action = "فوروارد" if is_forward else "ارسال"
    format_line = f"📝 **نوع پیام:** {format_name}\n" if format_name else ""
    return (
        f"📢 **{action} همگانی**\n\n"
        f"👥 **تعداد گیرندگان:** {target_count}\n"
        f"⚙️ **حالت:** {mode_name}\n"
        f"{format_line}"
        f"⏱️ **تاخیر بین پیام‌ها:** {delay_ms}ms\n"
        f"📦 **اندازه دسته:** {batch_size}\n"
        f"⏸️ **تاخیر بین دسته‌ها:** {batch_delay_str}\n"
        f"⏰ **زمان تخمینی:** {estimated_time_str}\n\n"
        f"برای شروع ارسال، دکمه '✅ تایید و شروع' را بزنید."
    )


def settings_text(job) -> str:
    batch_delay_str = format_batch_delay(job.batch_delay_ms)
    format_name = format_label(job.payload_json.get("parse_mode"))
    return (
        f"⚙️ **تنظیمات ارسال همگانی**\n\n"
        f"⏱️ **تاخیر بین پیام‌ها:** {job.delay_ms}ms\n"
        f"📦 **اندازه دسته:** {job.batch_size}\n"
        f"⏸️ **تاخیر بین دسته‌ها:** {batch_delay_str}\n"
        f"🎯 **حالت:** {MODE_NAMES_SETTINGS.get(job.target_mode, job.target_mode)}\n"
        f"📝 **نوع پیام:** {format_name}\n\n"
        f"برای تغییر تنظیمات، از دکمه‌های زیر استفاده کنید."
    )


STARTING_TEXT = "⏳ **در حال شروع ارسال همگانی...**"


def resumed_monitor_header(job) -> str:
    status_name = STATUS_NAMES.get(job.status, job.status)
    mode_name = MODE_NAMES_EMOJI.get(job.target_mode, job.target_mode)
    return (
        f"🔄 **ربات مجدداً راه‌اندازی شد**\n\n"
        f"📌 **همگانی #{job.id}**\n"
        f"📍 **وضعیت:** {status_name}\n"
        f"🎯 **حالت:** {mode_name}\n\n"
        f"گزارش پیشرفت در همین پیام به‌روزرسانی می‌شود."
    )


def queue_status_text(
    *,
    job_id: int,
    job_mode: str,
    job_targets: int,
    queue_position: int,
    active_mode: str | None = None,
    active_progress: float | None = None,
) -> str:
    text = "📋 **همگانی به صف اضافه شد!**\n\n"
    if active_mode is not None and active_progress is not None:
        text += f"🔄 **همگانی در حال اجرا:**\n   • حالت: {active_mode}\n   • پیشرفت: {active_progress:.1f}%\n\n"
    else:
        text += "⏳ **همگانی قبلی در حال اتمام است...**\n\n"
    text += (
        f"📌 **همگانی شما در صف:**\n"
        f"   • شماره: #{job_id}\n"
        f"   • حالت: {job_mode}\n"
        f"   • تعداد گیرندگان: {job_targets:,}\n"
        f"   • موقعیت در صف: {queue_position}\n\n"
        f"✅ وقتی نوبت شما برسد، همگانی به صورت خودکار شروع می‌شود."
    )
    return text


def running_status_text(status: dict, *, just_started: bool = False) -> str:
    floodwait_str = format_floodwait_time(status.get("total_floodwait_seconds", 0))
    header = "🚀 **همگانی شما شروع شد!**" if just_started else "📢 **ارسال همگانی در جریان است!**"
    completed = status["sent_ok"] + status["sent_fail"] + status["blocked"] + status["deleted"]
    return (
        f"{header}\n\n"
        f"👥 **کل کاربران:** {status['total_targets']}\n"
        f"✅ **ارسال موفق:** {status['sent_ok']}\n"
        f"🚫 **بلاک شده:** {status['blocked']}\n"
        f"⚠️ **حذف شده:** {status['deleted']}\n"
        f"❌ **ناموفق:** {status['sent_fail']}\n"
        f"⏳ **FloodWait:** {status['floodwait_count']} بار ({floodwait_str})\n"
        f"📈 **درصد پیشرفت:** {status['progress_percent']:.1f}%\n"
        f"⏳ **وضعیت:** {completed} / {status['total_targets']}"
    )


def final_status_text(status: dict) -> str:
    floodwait_str = format_floodwait_time(status.get("total_floodwait_seconds", 0))
    if status["status"] == "done":
        header = "📢 **ارسال همگانی به اتمام رسید!** ✅"
    elif status["status"] == "canceled":
        header = "📢 **ارسال همگانی لغو شد.** ⛔"
    else:
        header = "📢 **ارسال همگانی متوقف شد.** ⚠️"
    return (
        f"{header}\n\n"
        f"👥 **کل کاربران:** {status['total_targets']}\n"
        f"✅ **ارسال موفق:** {status['sent_ok']}\n"
        f"🚫 **بلاک شده:** {status['blocked']}\n"
        f"⚠️ **حذف شده:** {status['deleted']}\n"
        f"❌ **ناموفق:** {status['sent_fail']}\n"
        f"⏳ **FloodWait:** {status['floodwait_count']} بار ({floodwait_str})\n"
        f"📈 **درصد موفقیت:** {(status['sent_ok'] / status['total_targets'] * 100) if status['total_targets'] > 0 else 0:.1f}%\n"
        f"📊 **وضعیت نهایی:** {status['sent_ok'] + status['sent_fail'] + status['blocked'] + status['deleted']} / {status['total_targets']}"
    )


def job_detail_text(job) -> str:
    mode_name = MODE_NAMES_EMOJI.get(job.target_mode, job.target_mode)
    status_name = STATUS_NAMES.get(job.status, job.status)
    sent = job.sent_ok + job.sent_fail + job.blocked + job.deleted
    remaining = (job.total_targets or 0) - sent
    return (
        f"📊 **جزئیات همگانی #{job.id}**\n\n"
        f"📍 **وضعیت:** {status_name}\n"
        f"🎯 **حالت:** {mode_name}\n"
        f"👥 **کل گیرندگان:** {job.total_targets:,}\n\n"
        f"✅ **ارسال موفق:** {job.sent_ok:,}\n"
        f"❌ **ارسال ناموفق:** {job.sent_fail:,}\n"
        f"🚫 **بلاک شده:** {job.blocked:,}\n"
        f"🗑️ **حذف شده:** {job.deleted:,}\n"
        f"📤 **ارسال شده:** {sent:,}\n"
        f"📥 **باقیمانده:** {remaining:,}\n"
    )
