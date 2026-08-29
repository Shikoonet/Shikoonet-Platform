"""Callback handlers for admin support actions."""

from telethon import Button, events

from app.db.crud.user import clear_user_status, set_user_status
from app.telegram.keyboards.admin import Home_Back
from app.telegram.state import set_data, set_step
from config import ADMIN_ID

_SUPPORT_CALLBACK_PREFIXES = (
    "sendm_",
    "bansup_",
    "unbansup_",
    "unbanunbansup_",
    "banbansup_",
)


def _support_callback_filter(event: events.CallbackQuery.Event) -> bool:
    if event.sender_id not in ADMIN_ID:
        return False
    data = event.data.decode("UTF-8")
    return data.startswith(_SUPPORT_CALLBACK_PREFIXES)


async def callback_sup(event: events.CallbackQuery.Event):
    data = event.data.decode("UTF-8")
    if data.startswith("sendm_"):
        iduser = data.replace("sendm_", "")
        await event.respond(f"پیام خود را به کاربر ( {iduser} ) ارسال کنید:", buttons=Home_Back)
        await set_step(event.sender_id, "sendSupport")
        await set_data(event.sender_id, "idUserSupport", iduser)

    elif data.startswith("bansup_"):
        data = event.data.decode()
        from_id = int(data.split("_")[1])
        try:
            await event.answer("⛔️ کاربر مسدود شد.", alert=True)
            await set_user_status(from_id, "ban")
            await event.respond(
                f"🔒 کاربر <a href='tg://user?id={from_id}'>{from_id}</a> بن شد.",
                parse_mode="html",
                buttons=[
                    Button.inline("📨 ارسال پاسخ", f"sendm_{from_id}"),
                    Button.inline("✅ رفع مسدودی", f"unbanunbansup_{from_id}"),
                ],
            )

        except Exception as e:
            await event.answer(f"خطا در بن کردن کاربر: {e!s}", alert=True)

    elif data.startswith("unbansup_"):
        data = event.data.decode()
        from_id = int(data.split("_")[1])
        try:
            await event.answer(" کاربر ✅ رفع مسدودی شد.", alert=True)
            await clear_user_status(from_id)
            await event.respond(
                f"🔒 کاربر <a href='tg://user?id={from_id}'>{from_id}</a> ان بن شد.",
                parse_mode="html",
                buttons=[
                    Button.inline("📨 ارسال پاسخ", f"sendm_{from_id}"),
                    Button.inline("🚫 مسدود کردن", f"banbansup_{from_id}"),
                ],
            )

        except Exception as e:
            await event.answer(f"خطا در بن کردن کاربر: {e!s}", alert=True)

    elif data.startswith("unbanunbansup_"):
        data = event.data.decode()
        from_id = int(data.split("_")[1])
        try:
            await event.answer(" کاربر ✅ رفع مسدودی شد.", alert=True)
            await clear_user_status(from_id)
            await event.edit(
                f"🔒 کاربر <a href='tg://user?id={from_id}'>{from_id}</a> ان بن شد.",
                parse_mode="html",
                buttons=[
                    Button.inline("📨 ارسال پاسخ", f"sendm_{from_id}"),
                    Button.inline("🚫 مسدود کردن", f"banbansup_{from_id}"),
                ],
            )

        except Exception as e:
            await event.answer(f"خطا در بن کردن کاربر: {e!s}", alert=True)
    elif data.startswith("banbansup_"):
        data = event.data.decode()
        from_id = int(data.split("_")[1])
        try:
            await event.answer("⛔️ کاربر مسدود شد.", alert=True)
            await set_user_status(from_id, "ban")
            await event.edit(
                f"🔒 کاربر <a href='tg://user?id={from_id}'>{from_id}</a> بن شد.",
                parse_mode="html",
                buttons=[
                    Button.inline("📨 ارسال پاسخ", f"sendm_{from_id}"),
                    Button.inline("✅ رفع مسدودی", f"unbansup_{from_id}"),
                ],
            )

        except Exception as e:
            await event.answer(f"خطا در بن کردن کاربر: {e!s}", alert=True)


def register(client):
    client.add_event_handler(callback_sup, events.CallbackQuery(func=_support_callback_filter))
