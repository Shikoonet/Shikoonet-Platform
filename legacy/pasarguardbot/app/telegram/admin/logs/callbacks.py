"""Callback handlers for admin log management."""

from telethon import events

from app.db.crud.log_channels import LogChannelManager
from app.telegram.admin.logs import keyboards, states, texts
from app.telegram.keyboards.admin import Panel_Admin_Buttons
from app.telegram.state import set_step
from config import ADMIN_ID


def log_callback_filter(event: events.CallbackQuery.Event) -> bool:
    if event.sender_id not in ADMIN_ID:
        return False
    data = event.data.decode("utf-8")
    if data in {
        keyboards.BACK_TO_LOG_MANAGEMENT,
        keyboards.BACK_TO_ADMIN_PANEL,
        states.LOG_SHOW_STATUS,
        states.LOG_SET_ALL,
    }:
        return True
    return bool(
        data.startswith(states.LOG_TYPE_PREFIX)
        or data.startswith("log_dest_channel:")
        or data.startswith("log_dest_supergroup:")
    )


async def _show_log_management_menu(event: events.CallbackQuery.Event) -> None:
    await set_step(user_id=event.sender_id, step=states.LOG_MANAGEMENT_STEP)
    await event.edit(
        texts.LOG_MANAGEMENT_TEXT,
        buttons=keyboards.main_menu_buttons(),
    )


async def callback_log_admin(event: events.CallbackQuery.Event):
    data = event.data.decode("utf-8")

    if data == keyboards.BACK_TO_LOG_MANAGEMENT:
        await _show_log_management_menu(event)

    elif data == keyboards.BACK_TO_ADMIN_PANEL:
        await set_step(user_id=event.sender_id, step="panel")
        username = event.sender.username if event.sender.username else "بدون نام کاربری"
        await event.edit(
            f"**🌺به پنل مدیریت خوش آمدید.**\nایدی عددی شما: `{event.sender_id}`\nنام کاربری شما: @{username}\n",
            buttons=Panel_Admin_Buttons,
        )

    elif data == states.LOG_SHOW_STATUS:
        await set_step(user_id=event.sender_id, step=states.SHOW_LOG_STATUS_STEP)
        all_logs = await LogChannelManager().get_all_log_channels()
        if not all_logs:
            await event.edit(
                texts.EMPTY_LOG_STATUS_TEXT,
                buttons=keyboards.back_rows(),
            )
        else:
            status_text = texts.LOG_STATUS_HEADER
            for log in all_logs:
                status_text += texts.status_line(log)
            await event.edit(
                status_text,
                buttons=keyboards.back_rows(),
            )

    elif data == states.LOG_SET_ALL:
        await set_step(user_id=event.sender_id, step=states.LOG_MANAGEMENT_STEP)
        await event.edit(
            texts.SET_ALL_DESTINATION_TEXT,
            buttons=keyboards.set_all_destination_rows(),
        )

    elif data.startswith(states.LOG_TYPE_PREFIX):
        log_type = data.split(":", 1)[1]
        await set_step(user_id=event.sender_id, step=states.LOG_MANAGEMENT_STEP)
        await event.edit(
            texts.destination_menu_text(log_type),
            buttons=keyboards.destination_type_rows(log_type),
        )

    elif data.startswith("log_dest_channel:"):
        log_type = data.split(":")[1]
        await set_step(user_id=event.sender_id, step=f"{states.SET_LOG_CHANNEL_PREFIX}{log_type}")
        await event.edit(
            texts.channel_setup_text(log_type),
            buttons=keyboards.back_rows(),
        )

    elif data.startswith("log_dest_supergroup:"):
        log_type = data.split(":")[1]
        await set_step(user_id=event.sender_id, step=f"{states.SET_LOG_SUPERGROUP_PREFIX}{log_type}")
        await event.edit(
            texts.supergroup_setup_text(log_type),
            buttons=keyboards.back_rows(),
        )

    raise events.StopPropagation


def register(client):
    client.add_event_handler(callback_log_admin, events.CallbackQuery(func=log_callback_filter))
