"""Request logging middleware."""

from __future__ import annotations

import logging

from app.logger.setup import get_logger, log
from app.telegram.middlewares.base import BaseMiddleware
from app.telegram.middlewares.context import MiddlewareContext
from config import LOG_MIDDLEWARE_DEBUG

logger = get_logger("middleware.logging")


class LoggingMiddleware(BaseMiddleware):
    name = "logging"
    priority = 5

    async def before(self, ctx: MiddlewareContext) -> None:
        if not LOG_MIDDLEWARE_DEBUG:
            return

        event = ctx.event
        preview = ""
        if ctx.is_callback and hasattr(event, "data") and event.data:
            preview = event.data.decode("utf-8", errors="replace")[:48]
        elif ctx.is_newmessage:
            text = getattr(getattr(event, "message", None), "message", None) or ""
            preview = str(text)[:48]

        log(
            logger,
            logging.DEBUG,
            "Middleware event",
            kind=ctx.kind,
            user_id=ctx.user_id,
            admin=ctx.is_admin,
            private=ctx.is_private,
            preview=preview or None,
        )
