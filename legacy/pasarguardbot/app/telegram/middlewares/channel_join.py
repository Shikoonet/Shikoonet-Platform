"""Block bot usage until the user joins all mandatory channels."""

from __future__ import annotations

from app.telegram.middlewares.base import BaseMiddleware, StopPipeline
from app.telegram.middlewares.context import MiddlewareContext
from app.telegram.shared.guards.channel_gate import (
    ensure_channel_membership,
    get_message_text,
    is_reserved_start_deeplink,
)

CHECK_JOIN_CALLBACK = "Check_join"


class ChannelJoinMiddleware(BaseMiddleware):
    name = "channel_join"
    priority = 35

    def applies(self, ctx: MiddlewareContext) -> bool:
        if ctx.is_admin or not ctx.user_id:
            return False
        if ctx.is_newmessage and (ctx.is_channel or not ctx.is_private):
            return False

        if ctx.is_callback:
            data = ctx.event.data.decode("utf-8")
            return data != CHECK_JOIN_CALLBACK

        if ctx.is_newmessage:
            return is_reserved_start_deeplink(ctx.event) or not get_message_text(ctx.event).lower().startswith("/start")

        return False

    async def before(self, ctx: MiddlewareContext) -> None:
        if await ensure_channel_membership(ctx.event, is_callback=ctx.is_callback):
            return
        raise StopPipeline()
