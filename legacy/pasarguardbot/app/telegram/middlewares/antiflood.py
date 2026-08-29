"""Rate limit / anti-spam (flood) middleware."""

from __future__ import annotations

import time

from app.telegram.middlewares.base import BaseMiddleware, StopPipeline
from app.telegram.middlewares.context import MiddlewareContext
from app.telegram.shared.utils.antispam_state import (
    MIN_MESSAGE_INTERVAL,
    SPAM_BLOCK_SECONDS,
    antispam_lock,
    check_antispam,
)


class AntifloodMiddleware(BaseMiddleware):
    name = "antiflood"
    priority = 40

    def applies(self, ctx: MiddlewareContext) -> bool:
        if ctx.is_admin or not ctx.user_id:
            return False
        return not (ctx.is_newmessage and (ctx.is_channel or not ctx.is_private))

    async def before(self, ctx: MiddlewareContext) -> None:
        now = time.time()
        async with antispam_lock:
            result = check_antispam(
                ctx.user_id,
                ctx.event_id,
                now=now,
                block_seconds=SPAM_BLOCK_SECONDS,
                min_interval=MIN_MESSAGE_INTERVAL,
            )

        if result.action in ("allow", "allow_same_event"):
            return

        if result.action == "spam" and result.notify_message:
            event = ctx.event
            try:
                if ctx.is_callback:
                    await event.answer(result.notify_message, alert=True)
                else:
                    await event.reply(result.notify_message)
            except Exception:
                pass

        raise StopPipeline()
