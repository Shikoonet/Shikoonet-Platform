"""Message handlers for admin discount code management."""

from __future__ import annotations

from telethon import Button, events
from telethon.tl.custom import Message

from app import Kenzo
from app.db.crud.discount_codes import DiscountCodeManager
from app.services.billing.sticky_discount import format_discount_deep_links_text
from app.telegram.admin.discounts import keyboards, service, states
from app.telegram.shared.url_presets import get_bot_username
from app.telegram.state import get_data, get_step, set_data, set_step
from config import ADMIN_ID


async def _discount_admin_message_filter(event: Message) -> bool:
    if event.sender_id not in ADMIN_ID:
        return False
    msg = (event.message.text or "").strip()
    if msg == states.DISCOUNT_MENU_MESSAGE:
        return True
    step = await get_step(event.sender_id)
    return step in states.DISCOUNT_ADMIN_STEPS


async def message_handler_discount_admin(event: Message):
    msg = (event.message.text or "").strip()
    step = await get_step(event.sender_id)

    if msg == states.DISCOUNT_MENU_MESSAGE:
        await service.show_main_menu(event)
        await set_step(event.sender_id, "takhfif_select")
        raise events.StopPropagation

    if step == "discount_user":
        if msg.isdigit():
            await set_data(event.sender_id, "discount_user_id", int(msg))
            await event.respond("مدت اعتبار کد را انتخاب کنید:", buttons=keyboards.days_buttons())
            await set_step(event.sender_id, "discount_days")
        else:
            await event.respond(
                "لطفاً فقط عدد وارد کنید",
                buttons=[[Button.inline("🔙 بازگشت", data="discount_create_back_type_from_user")]],
            )
        raise events.StopPropagation

    if step == "discount_code_input":
        await set_data(event.sender_id, "discount_manual_code", msg.strip().upper())
        await event.respond("نوع کد تخفیف را انتخاب کنید:", buttons=keyboards.create_type_buttons())
        await set_step(event.sender_id, "discount_type")
        raise events.StopPropagation

    if step == "discount_days_custom":
        seconds = service.parse_duration_input(msg)
        if seconds is None or seconds <= 0:
            await event.respond(
                "فرمت نامعتبر. مثال: `7` برای ۷ روز یا `12h` برای ۱۲ ساعت",
                parse_mode="md",
                buttons=[keyboards._back_row(keyboards.CREATE_BACK_DAYS)],
            )
            raise events.StopPropagation
        await set_data(event.sender_id, "discount_expiration_seconds", seconds)
        await event.respond("تعداد دفعات استفاده را انتخاب کنید:", buttons=keyboards.limit_buttons())
        await set_step(event.sender_id, "discount_limit")
        raise events.StopPropagation

    if step == "discount_limit_custom" and msg.isdigit():
        await set_data(event.sender_id, "discount_limit", int(msg))
        await event.respond("درصد تخفیف را انتخاب کنید:", buttons=keyboards.percent_buttons())
        await set_step(event.sender_id, "discount_percent")
        raise events.StopPropagation

    if step == "discount_limit_custom" and not msg.isdigit():
        await event.respond(
            "لطفاً فقط عدد وارد کنید",
            buttons=[keyboards._back_row(keyboards.CREATE_BACK_LIMIT)],
        )
        raise events.StopPropagation

    if step == "discount_percent_custom" and msg.isdigit():
        percent = int(msg)
        if not 1 <= percent <= 100:
            await event.respond(
                "درصد باید بین ۱ تا ۱۰۰ باشد.",
                buttons=[keyboards._back_row(keyboards.CREATE_BACK_PERCENT)],
            )
            raise events.StopPropagation
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
            await event.respond(text, parse_mode="md", buttons=service.created_success_buttons())
        else:
            await event.respond(
                "❌ خطا در ساخت کد (احتمالاً تکراری است)",
                buttons=[[Button.inline("🔙 بازگشت", data=keyboards.BACK_TO_DISCOUNT_MENU)]],
            )
        raise events.StopPropagation

    if step == "discount_percent_custom" and not msg.isdigit():
        await event.respond(
            "لطفاً فقط عدد وارد کنید",
            buttons=[keyboards._back_row(keyboards.CREATE_BACK_PERCENT)],
        )
        raise events.StopPropagation

    if step == "discount_edit_code":
        old_code = await get_data(event.sender_id, "discount_edit_code")
        if not old_code:
            raise events.StopPropagation
        ok, result = await DiscountCodeManager().rename_discount_code(old_code, msg)
        if ok:
            await set_data(event.sender_id, "discount_edit_code", result)
            await set_step(event.sender_id, "discount_info_view")
            await event.respond(f"✅ کد به `{result}` تغییر کرد.", parse_mode="md")
            await service.show_discount_info(event, result, edit=False)
        else:
            await event.respond(f"❌ {result}")
        raise events.StopPropagation

    if step == "discount_edit_user":
        code = await get_data(event.sender_id, "discount_edit_code")
        if not code or not msg.isdigit():
            await event.respond(
                "لطفاً فقط عدد وارد کنید.",
                buttons=[[Button.inline("🔙 بازگشت", data="discount_info_back")]],
            )
            raise events.StopPropagation
        user_id = int(msg)
        if user_id == 0:
            ok = await DiscountCodeManager().update_discount_fields(code, user_id=None, is_public=True)
        else:
            ok = await DiscountCodeManager().update_discount_fields(code, user_id=user_id, is_public=False)
        if ok:
            await set_step(event.sender_id, "discount_info_view")
            await event.respond("✅ کاربر کد تخفیف به‌روز شد.")
            await service.show_discount_info(event, code, edit=False)
        else:
            await event.respond("❌ خطا در به‌روزرسانی کاربر.")
        raise events.StopPropagation

    if step == "discount_edit_percent_custom" and msg.isdigit():
        code = await get_data(event.sender_id, "discount_edit_code")
        percent = int(msg)
        if not code or not 1 <= percent <= 100:
            await event.respond("درصد باید بین ۱ تا ۱۰۰ باشد.")
            raise events.StopPropagation
        await DiscountCodeManager().update_discount_fields(code, discount_percentage=percent)
        await set_step(event.sender_id, "discount_info_view")
        await event.respond(f"✅ درصد تخفیف به `{percent}%` تغییر کرد.", parse_mode="md")
        await service.show_discount_info(event, code, edit=False)
        raise events.StopPropagation

    if step == "discount_edit_limit_custom" and msg.isdigit():
        code = await get_data(event.sender_id, "discount_edit_code")
        limit = int(msg)
        if not code or limit < 1:
            await event.respond("عدد باید بزرگ‌تر از صفر باشد.")
            raise events.StopPropagation
        await DiscountCodeManager().update_discount_fields(code, usage_limit=limit)
        await set_step(event.sender_id, "discount_info_view")
        await event.respond(f"✅ سقف استفاده به `{limit}` تغییر کرد.", parse_mode="md")
        await service.show_discount_info(event, code, edit=False)
        raise events.StopPropagation

    if step == "discount_extend_custom":
        code = await get_data(event.sender_id, "discount_edit_code")
        seconds = service.parse_duration_input(msg)
        if not code or seconds is None or seconds <= 0:
            await event.respond(
                "فرمت نامعتبر. مثال: `7` برای ۷ روز یا `6h` برای ۶ ساعت",
                parse_mode="md",
                buttons=[[Button.inline("🔙 بازگشت", data=f"ExtendDiscountMenu:{code}")]] if code else None,
            )
            raise events.StopPropagation
        if await DiscountCodeManager().extend_discount(code, seconds=seconds):
            await set_step(event.sender_id, "discount_info_view")
            duration = service.format_duration(seconds)
            await event.respond(f"✅ اعتبار کد به میزان `{duration}` تمدید شد.", parse_mode="md")
            await service.show_discount_info(event, code, edit=False)
        else:
            await event.respond("❌ خطا در تمدید کد.")
        raise events.StopPropagation


def register(client):
    client.add_event_handler(
        message_handler_discount_admin,
        events.NewMessage(incoming=True, from_users=ADMIN_ID, func=_discount_admin_message_filter),
    )
