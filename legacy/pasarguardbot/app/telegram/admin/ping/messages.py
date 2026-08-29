"""Message handlers for admin ping command."""

from datetime import datetime

from telethon import events

from config import ADMIN_ID


async def ping_pong(event):
    if event.is_private:
        a = datetime.timestamp(datetime.now())
        message = await event.reply("**Pong!**")
        b = datetime.timestamp(datetime.now()) - a

        await message.edit(f"**Pong!**\nTook `{b:.3f}` seconds")


def register(client):
    client.add_event_handler(
        ping_pong,
        events.NewMessage(pattern=r"/ping$", incoming=True, from_users=ADMIN_ID),
    )
