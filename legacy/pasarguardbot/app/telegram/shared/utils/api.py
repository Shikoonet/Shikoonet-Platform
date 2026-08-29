"""Telegram API helpers: flood-wait handling and safe retries."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from functools import wraps

from telethon.errors import FloodWaitError


async def sleep_flood_wait(error: FloodWaitError, *, buffer_seconds: float = 1.0) -> None:
    """Wait for Telethon flood-wait duration plus a small buffer."""
    await asyncio.sleep(error.seconds + buffer_seconds)


async def call_with_flood_wait[T](
    coro_factory: Callable[[], Awaitable[T]],
    *,
    max_retries: int = 3,
    buffer_seconds: float = 1.0,
) -> T:
    """Run an async Telegram call, retrying on FloodWaitError."""
    last_error: FloodWaitError | None = None
    for _ in range(max_retries):
        try:
            return await coro_factory()
        except FloodWaitError as e:
            last_error = e
            await sleep_flood_wait(e, buffer_seconds=buffer_seconds)
    if last_error is not None:
        raise last_error
    raise RuntimeError("call_with_flood_wait exhausted retries without executing")


def retry_on_flood_wait(*, max_retries: int = 3, buffer_seconds: float = 1.0):
    """Decorator: retry async handler on FloodWaitError."""

    def decorator[T, **P](func: Callable[P, Awaitable[T]]) -> Callable[P, Awaitable[T]]:
        @wraps(func)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> T:
            last_error: FloodWaitError | None = None
            for _ in range(max_retries):
                try:
                    return await func(*args, **kwargs)
                except FloodWaitError as e:
                    last_error = e
                    await sleep_flood_wait(e, buffer_seconds=buffer_seconds)
            if last_error is not None:
                raise last_error
            return await func(*args, **kwargs)

        return wrapper

    return decorator
