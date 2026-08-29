"""Helper utilities for admin discount code management."""

from __future__ import annotations

import random
import string
from datetime import datetime
from typing import Any

from telethon import Button

from app import Kenzo
from app.db.crud.discount_codes import DiscountCodeManager
from app.db.models.discount_codes import DiscountCode
from app.logger import get_logger
from app.services.billing.sticky_discount import (
    count_sticky_assigned_users,
    count_sticky_users_for_code,
    format_discount_deep_links_text,
    get_sticky_assignment_stats,
)
from app.telegram.admin.discounts import keyboards, states
from app.telegram.shared.url_presets import get_bot_username
from app.telegram.state import delete_data
from app.utils.formatting.dates import Time_Date

logger = get_logger(__name__)


def generate_discount_code(length: int = 8) -> str:
    return "".join(random.choice(string.ascii_uppercase + string.digits) for _ in range(length))


async def clear_discount_creation_data(user_id: int) -> None:
    for key in states.DISCOUNT_CREATION_KEYS:
        await delete_data(user_id, key)


def format_duration(seconds: int) -> str:
    seconds = int(seconds)
    if seconds < 3600:
        return f"{seconds // 60} دقیقه"
    if seconds < 86400:
        hours = seconds // 3600
        return f"{hours} ساعت"
    days = seconds // 86400
    rem_hours = (seconds % 86400) // 3600
    if rem_hours:
        return f"{days} روز و {rem_hours} ساعت"
    return f"{days} روز"


def parse_duration_input(text: str) -> int | None:
    """Parse admin duration input: plain number = days, suffix h = hours."""
    raw = (text or "").strip().lower()
    if not raw:
        return None
    if raw.endswith("h"):
        part = raw[:-1].strip()
        if part.isdigit():
            return int(part) * 3600
        return None
    if raw.isdigit():
        return int(raw) * 86400
    return None


def format_created_success_message(
    *,
    code: str,
    is_public: str,
    target_id,
    expiration_seconds: int,
    limit: int,
    percent: int,
) -> str:
    exp_ts = int(datetime.now().timestamp()) + int(expiration_seconds)
    exp_date = datetime.fromtimestamp(exp_ts)
    type_label = "🌍 عمومی" if is_public == "True" else "💎 پرایوت"
    user_label = str(target_id) if target_id and is_public == "False" else "همه کاربران"
    duration_label = format_duration(expiration_seconds)

    return (
        "━━━━━━━━━━━━━━━━━━━━\n"
        "✅ **کد تخفیف با موفقیت ساخته شد**\n"
        "━━━━━━━━━━━━━━━━━━━━\n\n"
        f"🎟 **کد:** `{code.upper()}`\n"
        f"📋 **نوع:** {type_label}\n"
        f"👤 **مخاطب:** `{user_label}`\n"
        f"💸 **درصد تخفیف:** `{percent}%`\n"
        f"🔢 **سقف استفاده:** `{limit}` بار\n"
        f"⏳ **مدت اعتبار:** `{duration_label}`\n"
        f"📅 **تاریخ انقضا:** `{exp_date.strftime('%Y-%m-%d %H:%M')}`\n\n"
        "💡 کد را می‌توانید از لیست کدهای تخفیف مدیریت کنید."
    )


def created_success_buttons():
    return [
        [Button.inline("📋 مشاهده لیست", data=keyboards.BACK_TO_DISCOUNT_LIST)],
        [Button.inline("🔙 منوی کدتخفیف", data=keyboards.BACK_TO_DISCOUNT_MENU)],
    ]


def format_discount_info(discount: DiscountCode) -> str:
    code_display = (discount.code or "").upper()
    return (
        "---------------------\n"
        f"**📌 کد:** `{code_display}`\n"
        f"**🎁 کد تخفیف برای:** `{discount.user_id if discount.user_id else 'همه'}`\n"
        f"**💸 درصد تخفیف:** `{discount.discount_percentage}%`\n"
        f"**🔢 تعداد استفاده:** `{discount.times_used}`**/**`{discount.usage_limit}`\n"
        f"**📋 نوع کد:** {'`🌍 عمومی 🌍`' if discount.is_public else '`💎 پرایوت 💎`'}\n"
        f"**⏳ تاریخ انقضا:** `{datetime.fromtimestamp(discount.expiration_date)}`\n"
        f"( {Time_Date(discount.expiration_date)['remaining_days']} )\n"
        f"\n"
        f"**📅 تاریخ ایجاد:** `{datetime.fromtimestamp(discount.created_at)}`\n"
        "---------------------\n"
    )


async def show_discount_info(event, code: str, *, edit: bool = True) -> bool:
    discount = await DiscountCodeManager().discount_get_by_code(code=code)
    if not discount:
        buttons = [
            [Button.inline("کد تخفیف پیدا نشد 🫣", data="none")],
            [Button.inline("بازگشت به لیست", data=keyboards.BACK_TO_DISCOUNT_LIST)],
        ]
        text = "کدتخفیف پیدا نشد"
        if edit:
            await event.edit(text, buttons=buttons)
        else:
            await event.respond(text, buttons=buttons)
        return False

    message_text = format_discount_info(discount)
    bot_username = await get_bot_username(Kenzo)
    assigned = await count_sticky_users_for_code(discount.code)
    message_text += (
        f"\n\n👥 **ست‌شده روی حساب کاربران (Redis):** `{assigned}`\n\n"
        f"{format_discount_deep_links_text(bot_username, discount.code)}"
    )
    buttons = keyboards.discount_info_buttons(discount.code, is_public=bool(discount.is_public))
    if edit:
        await event.edit(message_text, parse_mode="md", buttons=buttons)
    else:
        await event.respond(message_text, parse_mode="md", buttons=buttons)
    return True


async def show_discount_codes(admin_id: int, page: int = 1, per_page: int = 10, edit: bool = False, origin_event=None):
    per_page = max(1, int(per_page))
    page = max(1, int(page))

    discount_codes = await DiscountCodeManager().get_all_discount_codes()

    if not discount_codes:
        text = "ℹ️ هیچ کد تخفیفی ثبت نشده است."
        buttons = [[Button.inline("🔙 بازگشت", data=keyboards.BACK_TO_DISCOUNT_MENU)]]
        if edit and origin_event:
            await origin_event.edit(text, buttons=buttons)
        else:
            await Kenzo.send_message(entity=admin_id, message=text, buttons=buttons)
        return

    total = len(discount_codes)
    total_pages = (total + per_page - 1) // per_page
    page = min(page, total_pages)

    start = (page - 1) * per_page
    end = start + per_page
    current_codes = discount_codes[start:end]

    rows = []
    for code in current_codes:
        exp_date = datetime.fromtimestamp(code.expiration_date)
        remaining_days = (exp_date - datetime.now()).days
        if remaining_days < 0:
            remaining_text = "Expired ❌"
        elif remaining_days == 0:
            remaining_text = "Expires Today ⏳"
        else:
            remaining_text = f"{remaining_days}d"

        status = "🌍" if getattr(code, "is_public", False) else "🔒"
        code_display = (code.code or "").upper()
        txt = f"{code_display} • {code.discount_percentage}% • {remaining_text} • {status}"
        rows.append([Button.inline(txt, data=f"discount_info:{code.code}:{page}")])

    nav = []
    if page > 1:
        nav.append(Button.inline("صفحه قبل ⩥", data=f"PrevDiscount:{page}"))
    if page < total_pages:
        nav.append(Button.inline("⩤ صفحه بعد", data=f"NextDiscount:{page}"))

    if nav:
        rows.append(nav)

    rows.append([Button.inline("🔙 بازگشت", data=keyboards.BACK_TO_DISCOUNT_MENU)])

    header = f"**📊 مدیریت کدهای تخفیف**\n\n🔢 تعداد کل: `{total}`\n📄 صفحه: `{page}/{total_pages}`"

    if edit and origin_event:
        try:
            await Kenzo.edit_message(
                entity=origin_event.original_update.user_id,
                message=origin_event.original_update.msg_id,
                text=header,
                buttons=rows,
            )
        except Exception as e:
            logger.error(f"Error editing discount codes message: {e}")
            await Kenzo.send_message(entity=admin_id, message=header, buttons=rows)
    else:
        await Kenzo.send_message(entity=admin_id, message=header, buttons=rows)


async def show_main_menu(event, *, edit: bool = False) -> None:
    text = "**به بخش مدیریت کدتخفیف خوش اومدید**\nیکی از گزینه های زیر رو انتخاب کنید"
    buttons = keyboards.main_menu_buttons()
    if edit:
        await event.edit(text, buttons=buttons)
    else:
        await event.respond(text, buttons=buttons)


def _usage_bar(used: int, total: int, width: int = 12) -> str:
    if total <= 0:
        return "░" * width
    filled = min(width, round((used / total) * width))
    return "█" * filled + "░" * (width - filled)


def _active_ratio(active: int, total: int) -> str:
    if total <= 0:
        return "0%"
    return f"{round((active / total) * 100, 1)}%"


def format_discount_stats(stats: dict[str, Any]) -> str:
    now_label = datetime.now().strftime("%Y-%m-%d %H:%M")
    total = stats["total"]

    if total == 0:
        return (
            "╔══════════════════════════╗\n"
            "║   📊 **آمار کدهای تخفیف**   ║\n"
            "╚══════════════════════════╝\n\n"
            "📭 هنوز هیچ کد تخفیفی ثبت نشده است.\n"
            f"🕒 زمان گزارش: `{now_label}`"
        )

    most = stats.get("most_used")
    highest = stats.get("highest_percent")
    newest = stats.get("newest_code")
    oldest = stats.get("oldest_code")

    lines = [
        "╔══════════════════════════════╗",
        "║  📊 **گزارش کامل کدهای تخفیف**  ║",
        "╚══════════════════════════════╝",
        "",
        f"🕒 **زمان گزارش:** `{now_label}`",
        "",
        "━━━━━━━━ 🗂 **نمای کلی** ━━━━━━━━",
        f"📦 **کل کدها:** `{total}`",
        f"✅ **فعال:** `{stats['active']}`  ({_active_ratio(stats['active'], total)} از کل)",
        f"⛔️ **غیرفعال:** `{stats['inactive']}`",
        f"   ├ ⏰ منقضی‌شده: `{stats['expired']}`",
        f"   ├ 🚫 سقف استفاده پر: `{stats['exhausted']}`",
        f"   └ ⚠️ انقضای نزدیک (۷ روز): `{stats['expiring_soon']}`",
        "",
        "━━━━━━━━ 🏷 **دسته‌بندی** ━━━━━━━━",
        f"🌍 **عمومی (Public):** `{stats['public']}`",
        f"💎 **پرایوت (Private):** `{stats['private']}`",
        "",
        "━━━━━━━━ 📈 **مصرف و استفاده** ━━━━━━━━",
        f"🔥 **کل دفعات استفاده:** `{stats['total_uses']}`",
        f"🎯 **ظرفیت کل:** `{stats['total_capacity']}`",
        f"♻️ **ظرفیت باقی‌مانده:** `{stats['remaining_uses']}`",
        f"📊 **نرخ مصرف:** `{stats['usage_rate']}%`",
        f"`{_usage_bar(stats['total_uses'], stats['total_capacity'])}`",
        f"🆕 **هرگز استفاده نشده:** `{stats['never_used']}`",
        f"✔️ **حداقل ۱ بار استفاده شده:** `{stats['with_usage']}`",
        f"💸 **میانگین درصد تخفیف:** `{stats['avg_percent']}%`",
        "",
        "━━━━━━━━ 🔗 **ست دیپ‌لینک (Redis)** ━━━━━━━━",
        f"👥 **کاربران با تخفیف ست‌شده:** `{stats.get('sticky_assigned_users', 0)}`",
    ]

    if most:
        code_label = (most.code or "").upper()
        used = int(most.times_used or 0)
        limit = int(most.usage_limit or 0)
        lines.extend(
            [
                "",
                "━━━━━━━━ 🏆 **پراستفاده‌ترین کد** ━━━━━━━━",
                f"🥇 **کد:** `{code_label}`",
                f"📌 **استفاده:** `{used}` / `{limit}`",
                f"`{_usage_bar(used, limit)}`",
                f"💸 **درصد:** `{most.discount_percentage}%`",
                f"📋 **نوع:** {'🌍 عمومی' if most.is_public else '💎 پرایوت'}",
            ]
        )

    top_used = stats.get("top_used") or []
    if len(top_used) > 1:
        lines.append("")
        lines.append("━━━━━━━━ 🎖 **۵ کد برتر** ━━━━━━━━")
        medals = ("🥇", "🥈", "🥉", "4️⃣", "5️⃣")
        for idx, item in enumerate(top_used[:5]):
            lines.append(
                f"{medals[idx]} `{(item.code or '').upper()}` — "
                f"`{item.times_used}/{item.usage_limit}` — `{item.discount_percentage}%`"
            )

    if highest:
        lines.extend(
            [
                "",
                "━━━━━━━━ 💎 **بیشترین درصد تخفیف** ━━━━━━━━",
                f"🔖 **کد:** `{(highest.code or '').upper()}`",
                f"💸 **درصد:** `{highest.discount_percentage}%`",
            ]
        )

    if newest and oldest:
        lines.extend(
            [
                "",
                "━━━━━━━━ 🕰 **تازه‌ترین / قدیمی‌ترین** ━━━━━━━━",
                f"🆕 **جدیدترین:** `{(newest.code or '').upper()}`",
                f"📅 **قدیمی‌ترین:** `{(oldest.code or '').upper()}`",
            ]
        )

    sticky_by_code = stats.get("sticky_by_code") or {}
    if sticky_by_code:
        lines.append("")
        lines.append("**📌 تعداد ست per کد:**")
        for code, count in sorted(sticky_by_code.items(), key=lambda item: item[1], reverse=True)[:10]:
            lines.append(f"• `{code}` → `{count}` کاربر")

    lines.append("")
    lines.append("💡 کدهای **فعال** = نه منقضی و نه پر شده.")
    return "\n".join(lines)


async def show_discount_stats(event, *, edit: bool = True) -> None:
    stats = await DiscountCodeManager().get_discount_statistics()
    stats["sticky_assigned_users"] = await count_sticky_assigned_users()
    stats["sticky_by_code"] = await get_sticky_assignment_stats()
    text = format_discount_stats(stats)
    buttons = keyboards.stats_buttons()
    if edit:
        await event.edit(text, parse_mode="md", buttons=buttons)
    else:
        await event.respond(text, parse_mode="md", buttons=buttons)
