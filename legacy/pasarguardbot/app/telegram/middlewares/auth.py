"""Auth helpers — extend with session/token checks when needed."""

from __future__ import annotations

from app.telegram.middlewares.base import BaseMiddleware
from app.telegram.middlewares.context import MiddlewareContext


class RequireUserMiddleware(BaseMiddleware):
    """Skip updates without ``sender_id`` (except admin pipeline already passed)."""

    name = "require_user"
    priority = 15

    def applies(self, ctx: MiddlewareContext) -> bool:
        return not ctx.is_admin

    async def before(self, ctx: MiddlewareContext) -> None:
        if not ctx.user_id:
            from app.telegram.middlewares.base import StopPipeline

            raise StopPipeline()
