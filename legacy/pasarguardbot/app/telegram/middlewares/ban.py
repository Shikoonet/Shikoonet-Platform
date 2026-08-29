"""Ban / blacklist check."""

from __future__ import annotations

from app.db.crud.user import get_user_status
from app.telegram.middlewares.base import BaseMiddleware, StopPipeline
from app.telegram.middlewares.context import MiddlewareContext


class BanCheckMiddleware(BaseMiddleware):
    name = "ban_check"
    priority = 30

    def applies(self, ctx: MiddlewareContext) -> bool:
        if ctx.is_admin:
            return False
        if not ctx.user_id:
            return False
        return not (ctx.is_newmessage and (ctx.is_channel or not ctx.is_private))

    async def before(self, ctx: MiddlewareContext) -> None:
        step = await get_user_status(ctx.user_id)
        if step == "ban":
            raise StopPipeline()
