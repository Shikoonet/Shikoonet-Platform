"""Admin context — admins skip restrictive middlewares via ``applies()`` checks."""

from __future__ import annotations

from app.telegram.middlewares.base import BaseMiddleware
from app.telegram.middlewares.context import MiddlewareContext


class AdminContextMiddleware(BaseMiddleware):
    """Ensures ``ctx.is_admin`` is set (already on context; documents intent in pipeline)."""

    name = "admin_context"
    priority = 10

    async def before(self, ctx: MiddlewareContext) -> None:
        ctx.extras["is_admin"] = ctx.is_admin


def skip_for_admin(middleware: BaseMiddleware) -> BaseMiddleware:
    """Wrap ``applies`` so middleware does not run for admins."""

    original_applies = middleware.applies

    def applies(ctx: MiddlewareContext) -> bool:
        if ctx.is_admin:
            return False
        return original_applies(ctx)

    middleware.applies = applies  # type: ignore[method-assign]
    return middleware
