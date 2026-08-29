"""Maintenance middleware — logic in app.telegram.shared.utils.maintenance."""

from __future__ import annotations

from app.telegram.middlewares.base import BaseMiddleware, StopPipeline
from app.telegram.middlewares.context import MiddlewareContext
from app.telegram.shared.utils.maintenance import block_if_bot_offline


class MaintenanceMiddleware(BaseMiddleware):
    """
    Global maintenance gate.
    Default: callbacks only (matches legacy behavior).
    """

    name = "maintenance"
    priority = 20

    def __init__(self, *, callbacks_only: bool = True) -> None:
        self._callbacks_only = callbacks_only

    def applies(self, ctx: MiddlewareContext) -> bool:
        if ctx.is_admin:
            return False
        if self._callbacks_only and not ctx.is_callback:
            return False
        return bool(ctx.user_id)

    async def before(self, ctx: MiddlewareContext) -> None:
        if await block_if_bot_offline(ctx.event):
            raise StopPipeline()
