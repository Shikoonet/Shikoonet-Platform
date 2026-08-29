"""Callback handlers for user start."""

from __future__ import annotations

from telethon import events

from app.db.crud.channels import ChannelManager
from app.db.crud.user import clear_reactivatable_status
from app.telegram.keyboards.home import bhome_buttons
from app.telegram.shared.guards.channel_gate import (
    CHANNEL_JOIN_MESSAGE,
    build_channel_join_buttons,
    get_not_joined_channels,
)
from app.telegram.shared.utils.maintenance import bot_is_offline
from app.telegram.state import get_step
from app.telegram.user.start import helpers
from app.utils.formatting.dates import Time_Date


@bot_is_offline
async def check_join_callback(event: events.CallbackQuery.Event):
    if await get_step(event.sender_id) == "ban":
        return

    lang = await helpers.get_user_lang(event.sender_id)
    not_joined_channels = await get_not_joined_channels(event.sender_id)

    if not not_joined_channels:
        await clear_reactivatable_status(event.sender_id)
        await event.delete()
        await event.answer("✅ شما در تمام کانال‌ها عضو هستید!", alert=False)
        welcome_text = await helpers.fetch_welcome_text()
        await event.respond(
            welcome_text,
            buttons=await bhome_buttons(event.sender_id, lang),
        )
        return

    channels_count = len(await ChannelManager().get_all_channels())
    buttons = build_channel_join_buttons(not_joined_channels)
    joined_count = channels_count - len(not_joined_channels)
    await event.edit(
        CHANNEL_JOIN_MESSAGE.format(date=Time_Date()["mf"]),
        buttons=buttons,
        parse_mode="html",
    )
    await event.answer(
        f"✅ شما در {joined_count} کانال عضو شدید! لطفاً در {len(not_joined_channels)} کانال باقی‌مانده هم عضو شوید.",
        alert=False,
    )


def register(client):
    client.add_event_handler(
        check_join_callback,
        events.CallbackQuery(pattern=rb"^Check_join$"),
    )
