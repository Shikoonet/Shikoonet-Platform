"""Message handlers for admin backup."""

from telethon import events
from telethon.tl.custom import Message

from app.db.crud.log_channels import LogChannelManager
from app.db.crud.settings import SettingsManager
from app.jobs.backup import reschedule_backup_job
from app.logger import LogType, get_logger
from app.telegram.admin.backup import keyboards, states, texts
from app.telegram.state import get_step, set_step
from config import ADMIN_ID

logger = get_logger(__name__)


async def _current_interval() -> int:
    settings = await SettingsManager().get_settings()
    if not settings:
        return 24
    return max(0, int(getattr(settings, "backup_interval_hours", 24) or 0))


async def _channel_configured() -> bool:
    dest = await LogChannelManager().get_log_channel_destination(LogType.BACKUP.value)
    return dest is not None


async def _show_menu(event: Message) -> None:
    hours = await _current_interval()
    await set_step(event.sender_id, states.BACKUP_STEP)
    await event.respond(
        texts.menu_text(hours, await _channel_configured()),
        buttons=keyboards.menu_buttons(hours),
        parse_mode="md",
    )


async def _backup_message_filter(event: Message) -> bool:
    if event.sender_id not in ADMIN_ID or not event.is_private:
        return False
    msg = (event.message.text or "").strip()
    if msg == states.BACKUP_MENU_TRIGGER:
        return True
    step = await get_step(event.sender_id)
    return step == states.SET_BACKUP_INTERVAL_STEP and bool(msg)


async def message_handler_backup(event: Message):
    msg = (event.message.text or "").strip()
    step = await get_step(event.sender_id)

    if msg == states.BACKUP_MENU_TRIGGER:
        await _show_menu(event)
        raise events.StopPropagation

    if step == states.SET_BACKUP_INTERVAL_STEP and msg:
        if not msg.isdigit():
            await event.respond(texts.NUMERIC_ONLY, buttons=keyboards.interval_prompt_buttons())
            raise events.StopPropagation

        hours = int(msg)
        settings = await SettingsManager().get_settings()
        if not settings:
            await event.respond("❌ تنظیمات ربات یافت نشد.")
            raise events.StopPropagation

        await SettingsManager().update_setting(settings.id, backup_interval_hours=hours)
        reschedule_backup_job(hours)

        if hours <= 0:
            await event.respond(texts.INTERVAL_DISABLED, parse_mode="md")
        else:
            await event.respond(texts.INTERVAL_SAVED_TEMPLATE.format(hours=hours), parse_mode="md")

        await _show_menu(event)
        raise events.StopPropagation


def register(client):
    client.add_event_handler(
        message_handler_backup,
        events.NewMessage(incoming=True, func=_backup_message_filter),
    )
