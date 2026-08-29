"""Callback handlers for admin home panel."""

import contextlib

from telethon import events

from app.telegram.admin.admin_home.service import send_admin_home
from config import ADMIN_ID


async def callback_back_to_admin_panel(event: events.CallbackQuery.Event):
    if not event.is_private:
        return
    await event.answer()
    with contextlib.suppress(Exception):
        await event.delete()
    user = await event.get_sender()
    username = user.username if user else None
    await send_admin_home(event.sender_id, username)
    raise events.StopPropagation


def register(client):
    client.add_event_handler(
        callback_back_to_admin_panel,
        events.CallbackQuery(data="back_to_admin_panel", func=lambda e: e.sender_id in ADMIN_ID),
    )
