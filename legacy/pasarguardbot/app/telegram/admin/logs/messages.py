"""Message handlers for admin log management."""

from telethon import events
from telethon.tl.custom import Message

from app import Kenzo
from app.db.crud.log_channels import LogChannelManager
from app.logger import get_logger
from app.telegram.admin.logs import keyboards, states, texts
from app.telegram.shared.utils.channels import parse_telegram_message_link
from app.telegram.state import clear_user, get_data, get_step, set_data, set_step
from config import ADMIN_ID

logger = get_logger(__name__)


def _log_types_for(log_type: str) -> list[str]:
    if log_type == states.SET_ALL_LOG_TYPE:
        return [key for key, _ in states.ALL_LOG_TYPES]
    return [log_type]


async def _save_log_destination(
    log_type: str,
    *,
    destination_type: str,
    chat_id: int,
    topic_id: int | None = None,
) -> None:
    log_manager = LogChannelManager()
    for item_type in _log_types_for(log_type):
        description = f"کانال لاگ {item_type}" if destination_type == "channel" else f"سوپرگروه لاگ {item_type}"
        await log_manager.create_or_update_log_channel(
            log_type=item_type,
            destination_type=destination_type,
            chat_id=chat_id,
            topic_id=topic_id,
            description=description,
        )


async def _send_test_message(log_type: str, chat_id: int, topic_id: int | None = None) -> None:
    message = (
        texts.test_all_success_text() if log_type == states.SET_ALL_LOG_TYPE else texts.test_success_text(log_type)
    )
    if topic_id is not None:
        await Kenzo.send_message(entity=chat_id, message=message, reply_to=topic_id)
    else:
        await Kenzo.send_message(entity=chat_id, message=message)


async def _log_admin_message_filter(event: Message) -> bool:
    if event.sender_id not in ADMIN_ID:
        return False
    msg = (event.message.text or "").strip()
    if msg == texts.LOG_ENTRY_MESSAGE:
        return True
    step = (await get_step(event.sender_id)) or ""
    return bool(step.startswith(states.LOG_INPUT_STEP_PREFIXES) and msg)


async def message_handler_log_admin(event: Message):
    msg = (event.message.text or "").strip()
    step = (await get_step(event.sender_id)) or ""

    if msg == texts.LOG_ENTRY_MESSAGE:
        await set_step(user_id=event.sender_id, step=states.LOG_MANAGEMENT_STEP)
        await event.respond(
            texts.LOG_MANAGEMENT_TEXT,
            buttons=keyboards.main_menu_buttons(),
        )
        raise events.StopPropagation

    if step.startswith(states.SET_LOG_CHANNEL_PREFIX) and msg:
        if msg.lstrip("-").isdigit():
            log_type = step.replace(states.SET_LOG_CHANNEL_PREFIX, "")
            chat_id = int(msg)
            await _save_log_destination(
                log_type,
                destination_type="channel",
                chat_id=chat_id,
            )
            try:
                await _send_test_message(log_type, chat_id)
                await event.respond(
                    texts.channel_configured_text(log_type, chat_id),
                    buttons=keyboards.back_to_management_button(),
                )
                await set_step(event.sender_id, states.LOG_MANAGEMENT_STEP)
            except Exception as e:
                await event.respond(
                    texts.channel_test_error_text(e),
                    buttons=keyboards.back_button(),
                )
        else:
            await event.respond(texts.INVALID_NUMERIC_ID_TEXT)
        raise events.StopPropagation

    if step.startswith(states.SET_LOG_SUPERGROUP_PREFIX) and msg:
        log_type = step.replace(states.SET_LOG_SUPERGROUP_PREFIX, "")
        parsed = parse_telegram_message_link(msg)
        if parsed:
            chat_id, topic_id = parsed
            try:
                await _save_log_destination(
                    log_type,
                    destination_type="supergroup",
                    chat_id=chat_id,
                    topic_id=topic_id,
                )
                try:
                    await _send_test_message(log_type, chat_id, topic_id)
                    await event.respond(
                        texts.supergroup_configured_text(log_type, chat_id, topic_id),
                        buttons=keyboards.back_to_management_button(),
                    )
                    await set_step(event.sender_id, states.LOG_MANAGEMENT_STEP)
                except Exception as e:
                    await event.respond(
                        texts.supergroup_configured_warning_text(log_type, chat_id, topic_id, e),
                        buttons=keyboards.back_to_management_button(),
                    )
                    await set_step(event.sender_id, states.LOG_MANAGEMENT_STEP)
            except Exception as e:
                await event.respond(
                    texts.log_setup_error_text(e),
                    buttons=keyboards.back_button(),
                )
        elif msg.lstrip("-").isdigit():
            chat_id = int(msg)
            await set_step(event.sender_id, f"{states.SET_LOG_TOPIC_PREFIX}{log_type}")
            await set_data(event.sender_id, "supergroup_chat_id", chat_id)
            await event.respond(
                texts.topic_prompt_text(log_type),
                buttons=keyboards.back_button(),
            )
        else:
            await event.respond(
                texts.INVALID_GROUP_OR_TOPIC_TEXT,
                buttons=keyboards.back_button(),
            )
        raise events.StopPropagation

    if step.startswith(states.SET_LOG_TOPIC_PREFIX) and msg:
        log_type = step.replace(states.SET_LOG_TOPIC_PREFIX, "")
        parsed = parse_telegram_message_link(msg)
        if parsed:
            chat_id_from_link, topic_id = parsed
            chat_id = await get_data(event.sender_id, "supergroup_chat_id")
            if not chat_id:
                chat_id = chat_id_from_link
        elif msg.lstrip("-").isdigit():
            topic_id = int(msg)
            chat_id = await get_data(event.sender_id, "supergroup_chat_id")
        else:
            await event.respond(
                texts.INVALID_TOPIC_TEXT,
                buttons=keyboards.back_button(),
            )
            raise events.StopPropagation

        if not chat_id:
            await event.respond(
                texts.MISSING_CHAT_ID_TEXT,
                buttons=keyboards.back_button(),
            )
            raise events.StopPropagation

        try:
            await _save_log_destination(
                log_type,
                destination_type="supergroup",
                chat_id=int(chat_id),
                topic_id=int(topic_id),
            )
            try:
                await _send_test_message(log_type, int(chat_id), int(topic_id))
            except Exception as topic_error:
                logger.warning("Failed to send to topic %s: %s", topic_id, topic_error)
                await Kenzo.send_message(
                    entity=int(chat_id),
                    message=texts.topic_test_fallback_text(topic_id, log_type),
                )

            await clear_user(event.sender_id)
            await event.respond(
                texts.supergroup_configured_text(log_type, chat_id, topic_id),
                buttons=keyboards.back_to_management_button(),
            )
            await set_step(event.sender_id, states.LOG_MANAGEMENT_STEP)
        except Exception as e:
            await event.respond(
                texts.log_setup_error_text(e),
                buttons=keyboards.back_button(),
            )
        raise events.StopPropagation


def register(client):
    client.add_event_handler(
        message_handler_log_admin,
        events.NewMessage(incoming=True, from_users=ADMIN_ID, func=_log_admin_message_filter),
    )
