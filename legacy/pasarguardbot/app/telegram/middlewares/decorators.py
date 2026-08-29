"""Handler decorators — no imports from app.telegram package root."""

from __future__ import annotations

from functools import wraps

from app.telegram.shared.utils.maintenance import block_if_bot_offline, bot_is_offline
from config import ADMIN_ID

__all__ = ["admin_only", "block_if_bot_offline", "bot_is_offline"]


def admin_only(handler):
    """Run handler only for configured admins."""

    @wraps(handler)
    async def wrapper(event, *args, **kwargs):
        if event.sender_id not in ADMIN_ID:
            return None
        return await handler(event, *args, **kwargs)

    return wrapper
