"""Telegram middleware pipeline — register once at bot startup via register_global_middlewares()."""

from __future__ import annotations

from app.logger import LogTag, get_logger
from app.telegram.middlewares.admin import AdminContextMiddleware
from app.telegram.middlewares.antiflood import AntifloodMiddleware
from app.telegram.middlewares.ban import BanCheckMiddleware
from app.telegram.middlewares.channel_join import ChannelJoinMiddleware
from app.telegram.middlewares.error_handler import ErrorBoundaryMiddleware
from app.telegram.middlewares.logging_mw import LoggingMiddleware
from app.telegram.middlewares.maintenance import MaintenanceMiddleware
from app.telegram.middlewares.manager import (
    PIPELINE_CALLBACK,
    PIPELINE_NEWMESSAGE,
    middleware_manager,
)
from app.telegram.middlewares.telethon_bridge import (  # noqa: F401 — registers @Kenzo handlers
    middleware_callback_handler,
    middleware_newmessage_handler,
)

logger = get_logger(__name__)


__all__ = [
    "PIPELINE_CALLBACK",
    "PIPELINE_NEWMESSAGE",
    "middleware_manager",
    "register_global_middlewares",
]


def register_global_middlewares() -> None:
    """
    Build default global pipelines (order = priority, low first).
    Importing this module registers Telethon bridge handlers.
    """
    newmessage_chain = [
        ErrorBoundaryMiddleware(),
        LoggingMiddleware(),
        AdminContextMiddleware(),
        BanCheckMiddleware(),
        ChannelJoinMiddleware(),
        AntifloodMiddleware(),
    ]
    callback_chain = [
        ErrorBoundaryMiddleware(),
        LoggingMiddleware(),
        AdminContextMiddleware(),
        MaintenanceMiddleware(callbacks_only=True),
        BanCheckMiddleware(),
        ChannelJoinMiddleware(),
        AntifloodMiddleware(),
    ]

    middleware_manager.register_many(PIPELINE_NEWMESSAGE, newmessage_chain)
    middleware_manager.register_many(PIPELINE_CALLBACK, callback_chain)
    logger.info(
        "%s Pipeline ready | newmessage=%s callback=%s",
        LogTag.MIDDLEWARE,
        len(newmessage_chain),
        len(callback_chain),
    )
