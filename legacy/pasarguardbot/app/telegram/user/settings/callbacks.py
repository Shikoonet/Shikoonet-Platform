"""Callback handlers for user advanced settings."""

from telethon import Button, events

from app.db.crud.services import ServiceCRUD
from app.db.crud.user import UserCRUD
from app.telegram.keyboards.home import bhome_buttons
from app.telegram.keyboards.user_settings import (
    create_buttons_row_count,
    create_buttons_row_size,
    create_buttons_user_settings,
)
from app.telegram.shared.utils.maintenance import bot_is_offline
from app.telegram.shared.utils.rate_limit import debounce_callback
from app.telegram.state import set_step

from .messages import BOT_LANGUAGE


@bot_is_offline
@debounce_callback()
async def callback_user_settings(event: events.CallbackQuery.Event):
    data = event.data.decode()
    user_id = event.sender_id
    user = await UserCRUD().read_user(user_id)
    lang = user.language if user and user.language else BOT_LANGUAGE
    has_service = await ServiceCRUD().has_active_service(user_id)
    if data != "user_setting.back" and not has_service:
        await event.answer("⛔️ شما هیچ سرویس فعالی ندارید", alert=True)
        return
    if data == "user_setting.back":
        await set_step(event.sender_id, "home")
        await event.edit("تنظیمات پیشرفته بسته شد", buttons=await bhome_buttons(event.sender_id, lang))
        return
    if data == "user_setting.show_volume":
        await UserCRUD().update_user(event.sender_id, show_volume=not user.show_volume)
    elif data == "user_setting.show_panel":
        await UserCRUD().update_user(event.sender_id, show_panel=not user.show_panel)
    elif data == "user_setting.show_service_word":
        await UserCRUD().update_user(event.sender_id, show_service_word=not user.show_service_word)
    elif data == "user_setting.show_config_name":
        await UserCRUD().update_user(event.sender_id, show_config_name=not user.show_config_name)
    elif data == "user_setting.row_size_menu":
        buttons = create_buttons_row_size(user.service_buttons_per_row or 1)
        await event.edit("🕹 تعداد نمایش دکمه‌ها در هر ردیف از (چپ به راست) را انتخاب کنید", buttons=buttons)
        return
    elif data.startswith("user_setting.row_size."):
        if data.endswith("back"):
            buttons = create_buttons_user_settings(user)
            await event.edit("تنظیمات نمایش سرویس", buttons=buttons)
            return
        try:
            value = int(data.rsplit(".", 1)[1])
            if 1 <= value <= 8:
                await UserCRUD().update_user(event.sender_id, service_buttons_per_row=value)
        except ValueError:
            pass
    elif data == "user_setting.row_count_menu":
        buttons = create_buttons_row_count(user.service_button_rows or 1)
        await event.edit("🕹 تعداد نمایش دکمه‌ها در هر ردیف از (بالا به پایین) را انتخاب کنید", buttons=buttons)
        return
    elif data.startswith("user_setting.row_count."):
        if data.endswith("back"):
            buttons = create_buttons_user_settings(user)
            await event.edit("تنظیمات نمایش سرویس", buttons=buttons)
            return
        try:
            value = int(data.rsplit(".", 1)[1])
            if 1 <= value <= 20:
                await UserCRUD().update_user(event.sender_id, service_button_rows=value)
        except ValueError:
            pass
    elif data == "user_setting.qr_text":
        await set_step(event.sender_id, "qr_text")
        await event.edit(
            "متن خود را ارسال کنید تا بارکد ساخته شود",
            buttons=[Button.inline("بازگشت", b"user_setting.qr_text.back")],
        )
        return
    elif data == "user_setting.qr_text.back":
        await set_step(event.sender_id, "advanced_settings")
        buttons = create_buttons_user_settings(user)
        await event.edit("تنظیمات نمایش سرویس", buttons=buttons)
        return
    user = await UserCRUD().read_user(event.sender_id)
    buttons = create_buttons_user_settings(user)
    await event.edit("تنظیمات نمایش سرویس", buttons=buttons)


def register(client):
    client.add_event_handler(
        callback_user_settings,
        events.CallbackQuery(pattern=rb"user_setting\..*"),
    )
