from __future__ import annotations

import time
from functools import wraps

from app.logger import get_logger

logger = get_logger(__name__)

handler_execution_count = {}
message_handler_map = {}


def track_handler(f):
    """Track handler executions and duplicate handler fan-out per Telegram event."""
    handler_name = f"{f.__module__}.{f.__name__}"

    @wraps(f)
    async def decorated(update):
        user_id = getattr(update, "sender_id", "Unknown")
        message_text = ""
        event_id = None

        if hasattr(update, "message") and update.message:
            message_text = getattr(update.message, "message", "")[:50]
            event_id = getattr(update.message, "id", None)
        elif hasattr(update, "text"):
            message_text = update.text[:50]
            event_id = getattr(update, "id", None)
        elif hasattr(update, "data"):
            message_text = f"[Callback: {update.data.decode('utf-8')[:30]}]"
            event_id = getattr(update, "msg_id", None)

        handler_execution_count[handler_name] = handler_execution_count.get(handler_name, 0) + 1

        msg_key = f"{user_id}_{event_id}" if event_id else f"{user_id}_{time.time()}"
        if msg_key not in message_handler_map:
            message_handler_map[msg_key] = []
        message_handler_map[msg_key].append(handler_name)

        handlers_count = len(message_handler_map.get(msg_key, []))
        logger.info(
            "📍 Handler #%s: %s | User: %s | Msg: '%s' | Total executions: %s",
            handlers_count,
            f.__name__,
            user_id,
            message_text,
            handler_execution_count[handler_name],
        )

        if len(message_handler_map) > 100:
            oldest_keys = list(message_handler_map.keys())[:50]
            for key in oldest_keys:
                del message_handler_map[key]

        return await f(update)

    return decorated
