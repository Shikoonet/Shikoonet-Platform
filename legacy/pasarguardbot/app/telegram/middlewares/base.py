"""Middleware base types and pipeline control."""

from __future__ import annotations

from typing import Any

from app.telegram.middlewares.context import MiddlewareContext


class StopPipeline(Exception):
    """Raised when middleware should block further handlers (maps to StopPropagation)."""


class BaseMiddleware:
    """
    Async middleware hook.
    Lower ``priority`` runs earlier in the before-chain.
    """

    name: str = "base"
    priority: int = 100

    def applies(self, ctx: MiddlewareContext) -> bool:
        return True

    async def before(self, ctx: MiddlewareContext) -> None:
        """Run before business handlers. Raise StopPipeline to halt the event."""

    async def after(self, ctx: MiddlewareContext, handler_result: Any = None) -> None:
        """Optional post-handler hook (used by per-handler decorators)."""
