"""Callback handlers for admin discount code management."""

from __future__ import annotations

from datetime import datetime

from telethon import Button, events

from app import Kenzo
from app.db.crud.discount_codes import DiscountCodeManager
from app.db.crud.user import UserCRUD
from app.logger import get_logger
from app.services.billing.sticky_discount import format_discount_deep_links_text
from app.telegram.admin.discounts import keyboards, service, states
from app.telegram.keyboards.admin import Panel_Admin_Buttons
from app.telegram.shared.url_presets import get_bot_username
from app.telegram.state import get_data, get_step, set_data, set_step
from app.utils.formatting.dates import Time_Date
from config import ADMIN_ID

logger = get_logger(__name__)


def discount_callback_filter(event: events.CallbackQuery.Event) -> bool:
    if event.sender_id not in ADMIN_ID:
        return False
    data = event.data.decode("utf-8")
    static = {
        keyboards.BACK_TO_DISCOUNT_MENU,
        keyboards.BACK_TO_DISCOUNT_LIST,
        keyboards.DISCOUNT_LIST,
        keyboards.DISCOUNT_CREATE,
        keyboards.DISCOUNT_STATS,
        keyboards.BACK_TO_ADMIN_PANEL,
        keyboards.CREATE_BACK_FROM_DAYS,
        keyboards.CREATE_BACK_DAYS,
        keyboards.CREATE_BACK_LIMIT,
        keyboards.CREATE_BACK_PERCENT,
        "discount_info_back",
        "discount_create_back_type_from_user",
        "discount_type_public",
        "discount_type_private",
        "discount_custom_start",
    }
    if data in static:
        return True
    if data.startswith(
        (
            "discount_hours_",
            "discount_days_",
            "discount_limit_",
            "discount_percent_",
            "edit_discount_percent_",
            "edit_discount_limit_",
            "EditDiscCode:",
            "EditDiscPercent:",
            "EditDiscLimit:",
            "ResetDiscUsage:",
            "EditDiscUser:",
            "SetDiscPublic:",
            "SetDiscPrivate:",
            "ExtendDiscountMenu:",
            "ExtendDiscSec:",
            "ExtendDiscountCustom:",
        )
    ):
        return True
    if data.startswith("discount_info:"):
        return True
    return bool(
        data.startswith(("ExtendDiscount:", "DeleteDiscount:", "BackToTakhfifList", "PrevDiscount:", "NextDiscount:"))
    )


async def _show_days_menu(event: events.CallbackQuery.Event) -> None:
    await event.edit("مدت اعتبار کد را انتخاب کنید:", buttons=keyboards.days_buttons())
    await set_step(event.sender_id, "discount_days")


async def _show_limit_menu(event: events.CallbackQuery.Event) -> None:
    await event.edit("تعداد دفعات استفاده را انتخاب کنید:", buttons=keyboards.limit_buttons())
    await set_step(event.sender_id, "discount_limit")


async def _show_percent_menu(event: events.CallbackQuery.Event) -> None:
    await event.edit("درصد تخفیف را انتخاب کنید:", buttons=keyboards.percent_buttons())
    await set_step(event.sender_id, "discount_percent")


async def _create_discount_from_state(event: events.CallbackQuery.Event, percent: int) -> None:
    is_public = await get_data(event.sender_id, "discount_is_public")
    target_id = await get_data(event.sender_id, "discount_user_id")
    expiration_seconds = await get_data(event.sender_id, "discount_expiration_seconds")
    if not expiration_seconds:
        days = await get_data(event.sender_id, "discount_days")
        expiration_seconds = int(days or 30) * 86400
    limit = await get_data(event.sender_id, "discount_limit")
    custom_code = await get_data(event.sender_id, "discount_manual_code")
    code = (custom_code or service.generate_discount_code()).upper()
    result = await DiscountCodeManager().create_discount_code(
        code=code,
        is_public=is_public,
        user_id=int(target_id) if target_id and is_public == "False" else None,
        expiration_seconds=int(expiration_seconds),
        usage_limit=int(limit),
        discount_percentage=percent,
    )
    await service.clear_discount_creation_data(event.sender_id)
    await set_step(event.sender_id, "takhfif_select")
    if result:
        text = service.format_created_success_message(
            code=code,
            is_public=is_public,
            target_id=target_id,
            expiration_seconds=int(expiration_seconds),
            limit=int(limit),
            percent=percent,
        )
        bot_username = await get_bot_username(Kenzo)
        text += f"\n\n{format_discount_deep_links_text(bot_username, code)}"
        await event.edit(text, parse_mode="md", buttons=service.created_success_buttons())
    else:
        await event.edit(
            "❌ خطا در ساخت کد (احتمالاً تکراری است)",
            buttons=[[Button.inline("🔙 بازگشت", data=keyboards.BACK_TO_DISCOUNT_MENU)]],
        )


async def callback_discount_admin(event: events.CallbackQuery.Event):
    data = event.data.decode("utf-8")
    step = await get_step(event.sender_id)

    if data == keyboards.BACK_TO_ADMIN_PANEL:
        await set_step(event.sender_id, "panel")
        username = event.sender.username if event.sender.username else "بدون نام کاربری"
        await event.edit(
            f"**🌺به پنل مدیریت خوش آمدید.**\nایدی عددی شما: `{event.sender_id}`\nنام کاربری شما: @{username}\n",
            buttons=Panel_Admin_Buttons,
        )
        raise events.StopPropagation

    if data == keyboards.BACK_TO_DISCOUNT_MENU:
        await service.clear_discount_creation_data(event.sender_id)
        await set_step(event.sender_id, "takhfif_select")
        await service.show_main_menu(event, edit=True)
        raise events.StopPropagation

    if data == keyboards.DISCOUNT_LIST:
        await UserCRUD().update_user(user_id=event.sender_id, page=1)
        await set_step(event.sender_id, "takhfif_select")
        await service.show_discount_codes(
            admin_id=event.sender_id, page=1, per_page=states.DISCOUNT_PER_PAGE, edit=True, origin_event=event
        )
        raise events.StopPropagation

    if data == keyboards.DISCOUNT_CREATE:
        await event.edit("نوع کد تخفیف را انتخاب کنید:", buttons=keyboards.create_type_buttons())
        await set_step(event.sender_id, "discount_type")
        raise events.StopPropagation

    if data == keyboards.DISCOUNT_STATS:
        await set_step(event.sender_id, "takhfif_select")
        await service.show_discount_stats(event, edit=True)
        raise events.StopPropagation

    if data == "discount_create_back_type_from_user":
        await event.edit("نوع کد تخفیف را انتخاب کنید:", buttons=keyboards.create_type_buttons())
        await set_step(event.sender_id, "discount_type")
        raise events.StopPropagation

    if data == keyboards.CREATE_BACK_DAYS:
        await _show_days_menu(event)
        raise events.StopPropagation

    if data == keyboards.CREATE_BACK_LIMIT:
        await _show_limit_menu(event)
        raise events.StopPropagation

    if data == keyboards.CREATE_BACK_PERCENT:
        await _show_percent_menu(event)
        raise events.StopPropagation

    if data == keyboards.CREATE_BACK_FROM_DAYS:
        is_public = await get_data(event.sender_id, "discount_is_public")
        if is_public == "False":
            await event.edit(
                "آیدی عددی کاربر را ارسال کنید:",
                buttons=[[Button.inline("🔙 بازگشت", data="discount_create_back_type_from_user")]],
            )
            await set_step(event.sender_id, "discount_user")
        else:
            await event.edit("نوع کد تخفیف را انتخاب کنید:", buttons=keyboards.create_type_buttons())
            await set_step(event.sender_id, "discount_type")
        raise events.StopPropagation

    if data == "discount_type_public" and step == "discount_type":
        await set_data(event.sender_id, "discount_is_public", "True")
        await _show_days_menu(event)
        raise events.StopPropagation

    if data == "discount_type_private" and step == "discount_type":
        await set_data(event.sender_id, "discount_is_public", "False")
        await event.edit(
            "آیدی عددی کاربر را ارسال کنید:",
            buttons=[[Button.inline("🔙 بازگشت", data="discount_create_back_type_from_user")]],
        )
        await set_step(event.sender_id, "discount_user")
        raise events.StopPropagation

    if data == "discount_custom_start" and step == "discount_type":
        await event.edit(
            "کد مورد نظر را ارسال کنید:",
            buttons=[[Button.inline("🔙 بازگشت", data="discount_create_back_type_from_user")]],
        )
        await set_step(event.sender_id, "discount_code_input")
        raise events.StopPropagation

    if data.startswith("discount_hours_") and step == "discount_days":
        hours = int(data.split("_")[2])
        await set_data(event.sender_id, "discount_expiration_seconds", hours * 3600)
        await _show_limit_menu(event)
        raise events.StopPropagation

    if data.startswith("discount_days_") and step == "discount_days":
        if data == "discount_days_custom":
            await event.edit(
                "مدت اعتبار را وارد کنید:\n• عدد = روز (مثال: `7`)\n• با `h` = ساعت (مثال: `12h`)",
                parse_mode="md",
                buttons=[keyboards._back_row(keyboards.CREATE_BACK_DAYS)],
            )
            await set_step(event.sender_id, "discount_days_custom")
            raise events.StopPropagation
        days = int(data.split("_")[2])
        await set_data(event.sender_id, "discount_expiration_seconds", days * 86400)
        await _show_limit_menu(event)
        raise events.StopPropagation

    if data.startswith("discount_limit_") and step == "discount_limit":
        if data == "discount_limit_custom":
            await event.edit(
                "تعداد دفعات استفاده را وارد کنید:",
                buttons=[keyboards._back_row(keyboards.CREATE_BACK_LIMIT)],
            )
            await set_step(event.sender_id, "discount_limit_custom")
            raise events.StopPropagation
        limit = int(data.split("_")[2])
        await set_data(event.sender_id, "discount_limit", limit)
        await _show_percent_menu(event)
        raise events.StopPropagation

    if data.startswith("discount_percent_") and step == "discount_percent":
        if data == "discount_percent_custom":
            await event.edit(
                "درصد تخفیف را وارد کنید (۱ تا ۱۰۰):",
                buttons=[keyboards._back_row(keyboards.CREATE_BACK_PERCENT)],
            )
            await set_step(event.sender_id, "discount_percent_custom")
            raise events.StopPropagation
        percent = int(data.split("_")[2])
        await _create_discount_from_state(event, percent)
        raise events.StopPropagation

    if data.startswith("discount_info:") and step in states.DISCOUNT_INFO_STEPS:
        parts = data.split(":")
        code = parts[1]
        current_page = int(parts[2]) if len(parts) > 2 else 1
        await UserCRUD().update_user(user_id=event.sender_id, page=current_page)
        await set_data(event.sender_id, "discount_edit_code", code)
        await set_step(event.sender_id, "discount_info_view")
        await service.show_discount_info(event, code)
        raise events.StopPropagation

    if data == "discount_info_back":
        code = await get_data(event.sender_id, "discount_edit_code")
        if code:
            await set_step(event.sender_id, "discount_info_view")
            await service.show_discount_info(event, code)
        raise events.StopPropagation

    if data.startswith("EditDiscCode:") and step == "discount_info_view":
        code = data.replace("EditDiscCode:", "")
        await set_data(event.sender_id, "discount_edit_code", code)
        await event.edit(
            "کد جدید را وارد کنید (با حروف بزرگ ذخیره می‌شود):",
            buttons=[[Button.inline("🔙 بازگشت", data="discount_info_back")]],
        )
        await set_step(event.sender_id, "discount_edit_code")
        raise events.StopPropagation

    if data.startswith("EditDiscPercent:") and step == "discount_info_view":
        code = data.replace("EditDiscPercent:", "")
        await set_data(event.sender_id, "discount_edit_code", code)
        await event.edit("درصد تخفیف جدید را انتخاب کنید:", buttons=keyboards.edit_percent_buttons())
        await set_step(event.sender_id, "discount_edit_percent")
        raise events.StopPropagation

    if data.startswith("edit_discount_percent_") and step == "discount_edit_percent":
        code = await get_data(event.sender_id, "discount_edit_code")
        if not code:
            raise events.StopPropagation
        if data == "edit_discount_percent_custom":
            await event.edit(
                "درصد تخفیف جدید را وارد کنید:",
                buttons=[[Button.inline("🔙 بازگشت", data="discount_info_back")]],
            )
            await set_step(event.sender_id, "discount_edit_percent_custom")
            raise events.StopPropagation
        percent = int(data.split("_")[3])
        await DiscountCodeManager().update_discount_fields(code, discount_percentage=percent)
        await set_step(event.sender_id, "discount_info_view")
        await service.show_discount_info(event, code)
        raise events.StopPropagation

    if data.startswith("EditDiscLimit:") and step == "discount_info_view":
        code = data.replace("EditDiscLimit:", "")
        await set_data(event.sender_id, "discount_edit_code", code)
        await event.edit("سقف استفاده جدید را انتخاب کنید:", buttons=keyboards.edit_limit_buttons())
        await set_step(event.sender_id, "discount_edit_limit")
        raise events.StopPropagation

    if data.startswith("edit_discount_limit_") and step == "discount_edit_limit":
        code = await get_data(event.sender_id, "discount_edit_code")
        if not code:
            raise events.StopPropagation
        if data == "edit_discount_limit_custom":
            await event.edit(
                "سقف استفاده جدید را وارد کنید:",
                buttons=[[Button.inline("🔙 بازگشت", data="discount_info_back")]],
            )
            await set_step(event.sender_id, "discount_edit_limit_custom")
            raise events.StopPropagation
        limit = int(data.split("_")[3])
        await DiscountCodeManager().update_discount_fields(code, usage_limit=limit)
        await set_step(event.sender_id, "discount_info_view")
        await service.show_discount_info(event, code)
        raise events.StopPropagation

    if data.startswith("ResetDiscUsage:") and step == "discount_info_view":
        code = data.replace("ResetDiscUsage:", "")
        await DiscountCodeManager().reset_times_used(code)
        await set_data(event.sender_id, "discount_edit_code", code)
        await service.show_discount_info(event, code)
        raise events.StopPropagation

    if data.startswith("SetDiscPublic:") and step == "discount_info_view":
        code = data.replace("SetDiscPublic:", "")
        await DiscountCodeManager().update_discount_fields(code, user_id=None, is_public=True)
        await set_data(event.sender_id, "discount_edit_code", code)
        await service.show_discount_info(event, code)
        raise events.StopPropagation

    if data.startswith("SetDiscPrivate:") and step == "discount_info_view":
        code = data.replace("SetDiscPrivate:", "")
        await set_data(event.sender_id, "discount_edit_code", code)
        await event.edit(
            "برای پرایوت کردن، آیدی عددی کاربر را ارسال کنید:",
            buttons=[[Button.inline("🔙 بازگشت", data="discount_info_back")]],
        )
        await set_step(event.sender_id, "discount_edit_user")
        raise events.StopPropagation

    if data.startswith("EditDiscUser:") and step == "discount_info_view":
        code = data.replace("EditDiscUser:", "")
        await set_data(event.sender_id, "discount_edit_code", code)
        await event.edit(
            "آیدی عددی کاربر جدید را ارسال کنید:\n(برای عمومی کردن کد، عدد `0` بفرستید)",
            buttons=[[Button.inline("🔙 بازگشت", data="discount_info_back")]],
        )
        await set_step(event.sender_id, "discount_edit_user")
        raise events.StopPropagation

    if data.startswith("ExtendDiscountMenu:"):
        code = data.replace("ExtendDiscountMenu:", "")
        await set_data(event.sender_id, "discount_edit_code", code)
        await set_step(event.sender_id, "discount_info_view")
        await event.edit("مدت تمدید را انتخاب کنید:", buttons=keyboards.extend_buttons(code))
        raise events.StopPropagation

    if data.startswith("ExtendDiscSec:"):
        payload = data.removeprefix("ExtendDiscSec:")
        code, seconds = payload.rsplit(":", 1)
        if await DiscountCodeManager().extend_discount(code, seconds=int(seconds)):
            await set_data(event.sender_id, "discount_edit_code", code)
            await set_step(event.sender_id, "discount_info_view")
            await service.show_discount_info(event, code)
        raise events.StopPropagation

    if data.startswith("ExtendDiscountCustom:"):
        code = data.replace("ExtendDiscountCustom:", "")
        await set_data(event.sender_id, "discount_edit_code", code)
        await event.edit(
            "مدت تمدید را وارد کنید:\n• عدد = روز (مثال: `14`)\n• با `h` = ساعت (مثال: `6h`)",
            parse_mode="md",
            buttons=[[Button.inline("🔙 بازگشت", data=f"ExtendDiscountMenu:{code}")]],
        )
        await set_step(event.sender_id, "discount_extend_custom")
        raise events.StopPropagation

    if data.startswith("ExtendDiscount:") and step in states.DISCOUNT_INFO_STEPS:
        code = data.replace("ExtendDiscount:", "")
        if await DiscountCodeManager().extend_discount(code, seconds=86400 * 30):
            await set_data(event.sender_id, "discount_edit_code", code)
            await set_step(event.sender_id, "discount_info_view")
            await service.show_discount_info(event, code)
        raise events.StopPropagation

    if data.startswith("DeleteDiscount:") and step in states.DISCOUNT_INFO_STEPS:
        code = data.replace("DeleteDiscount:", "")
        status, discount = await DiscountCodeManager().delete_discount_code(code=code)
        if status:
            message_text = (
                "<del>---------------------</del>\n"
                f"<del>📌 کد: {(discount.code or '').upper()}</del>\n"
                f"<del>🎁 کد تخفیف برای: {discount.user_id if discount.user_id else 'همه'}</del>\n"
                f"<del>💸 درصد تخفیف: {discount.discount_percentage}%</del>\n"
                f"<del>🔢 تعداد استفاده: {discount.times_used}/{discount.usage_limit}</del>\n"
                f"<del>📋 نوع کد: {'🌍 عمومی 🌍' if discount.is_public else '💎 پرایوت 💎'}</del>\n"
                f"<del>⏳ تاریخ انقضا: {datetime.fromtimestamp(discount.expiration_date)}</del>\n"
                f"<del>( {Time_Date(discount.expiration_date)['remaining_days']} )</del>\n"
                f"<del>📅 تاریخ ایجاد: {datetime.fromtimestamp(discount.created_at)}</del>\n"
                "<del>---------------------</del>\n"
            )
            await event.edit(
                message_text,
                parse_mode="html",
                buttons=[
                    [Button.inline(f"🗑 کد {(discount.code or '').upper()} حذف شد", data="none")],
                    [Button.inline("بازگشت به لیست", data=keyboards.BACK_TO_DISCOUNT_LIST)],
                ],
            )
        else:
            await event.edit(
                "کدتخفیف پیدا نشد",
                buttons=[
                    [Button.inline("کد تخفیف پیدا نشد 🫣", data="none")],
                    [Button.inline("بازگشت به لیست", data=keyboards.BACK_TO_DISCOUNT_LIST)],
                ],
            )
        await set_step(event.sender_id, "takhfif_select")
        raise events.StopPropagation

    if data.startswith("BackToTakhfifList"):
        current_page = await UserCRUD().read_user(event.sender_id)
        page = current_page.page if current_page and current_page.page else 1
        await service.clear_discount_creation_data(event.sender_id)
        await set_step(event.sender_id, "takhfif_select")
        await service.show_discount_codes(
            admin_id=event.sender_id,
            page=page,
            per_page=states.DISCOUNT_PER_PAGE,
            edit=True,
            origin_event=event,
        )
        raise events.StopPropagation

    if data.startswith("PrevDiscount:") or data.startswith("NextDiscount:"):
        current_page = int(data.split(":")[1])
        discount_codes = await DiscountCodeManager().get_all_discount_codes()
        total_codes = len(discount_codes)
        per_page = states.DISCOUNT_PER_PAGE
        num_pages = max(1, (total_codes + per_page - 1) // per_page)

        if data.startswith("PrevDiscount:") and current_page > 1:
            current_page -= 1
        elif data.startswith("NextDiscount:") and current_page < num_pages:
            current_page += 1

        current_page = max(1, min(current_page, num_pages))
        await UserCRUD().update_user(user_id=event.sender_id, page=current_page)
        await set_step(event.sender_id, "takhfif_select")

        try:
            await service.show_discount_codes(
                admin_id=event.sender_id, page=current_page, per_page=per_page, edit=True, origin_event=event
            )
        except Exception as e:
            logger.error(f"Error in discount codes pagination: {e}")
            if "MessageNotModifiedError" in str(e):
                await service.show_discount_codes(
                    admin_id=event.sender_id,
                    page=current_page,
                    per_page=per_page,
                    edit=False,
                    origin_event=None,
                )
        raise events.StopPropagation

    raise events.StopPropagation


def register(client):
    client.add_event_handler(callback_discount_admin, events.CallbackQuery(func=discount_callback_filter))
