"""Pipeline error boundary — middleware failures must not crash the bot."""

from __future__ import annotations

from app.logger import get_logger
from app.telegram.middlewares.base import BaseMiddleware
from app.telegram.middlewares.context import MiddlewareContext

logger = get_logger(__name__)


class ErrorBoundaryMiddleware(BaseMiddleware):
    """
    Wraps the rest of the chain conceptually; individual failures are logged in
    ``MiddlewareManager.run_before``. This middleware is a no-op placeholder
    for future metrics/alerts.
    """

    name = "error_boundary"
    priority = 0

    async def before(self, ctx: MiddlewareContext) -> None:
        ctx.extras.setdefault("pipeline_started", True)
