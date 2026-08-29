"""Telethon client lifecycle and API event logging."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from functools import wraps
from typing import Any, TypeVar

from telethon import TelegramClient
from telethon.errors import FloodWaitError, RPCError

from app.logger.setup import get_logger, log as log_event, log_exception, log_flood_wait
from config import LOG_HANDLER_EVENTS

logger = get_logger("telegram")

F = TypeVar("F", bound=Callable[..., Any])

_watch_tasks: dict[int, asyncio.Task[None]] = {}


def register_telethon_client(client: TelegramClient) -> None:
    """Watch for unexpected disconnects while the client is running."""
    key = id(client)
    existing = _watch_tasks.get(key)
    if existing is not None and not existing.done():
        return
    _watch_tasks[key] = asyncio.create_task(_watch_disconnect(client))


def unregister_telethon_client(client: TelegramClient) -> None:
    """Stop the disconnect watcher (call before ``disconnect()`` to avoid log spam)."""
    task = _watch_tasks.pop(id(client), None)
    if task is not None and not task.done():
        task.cancel()


async def _watch_disconnect(client: TelegramClient) -> None:
    try:
        while client.is_connected():
            await client.disconnected
            if not client.is_connected():
                break
            logger.warning("Telegram connection lost — awaiting reconnect")
    except asyncio.CancelledError:
        pass


def log_handler(handler_name: str) -> Callable[[F], F]:
    """Optional decorator: log handler entry at DEBUG when LOG_HANDLER_EVENTS=true."""

    def decorator(func: F) -> F:
        if not LOG_HANDLER_EVENTS:

            @wraps(func)
            async def quiet_wrapper(*args: Any, **kwargs: Any) -> Any:
                return await func(*args, **kwargs)

            return quiet_wrapper  # type: ignore[return-value]

        @wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            event = args[0] if args else None
            user_id = getattr(event, "sender_id", None)
            log_event(
                logger,
                logging.DEBUG,
                "Handler start",
                handler=handler_name,
                user_id=user_id,
            )
            started = time.perf_counter()
            try:
                return await func(*args, **kwargs)
            except FloodWaitError as e:
                log_flood_wait(logger, e.seconds, context=handler_name, user_id=user_id)
                raise
            except RPCError as e:
                log_exception(
                    logger,
                    "Telegram API error",
                    exc=e,
                    handler=handler_name,
                    user_id=user_id,
                    error=type(e).__name__,
                )
                raise
            except Exception as e:
                log_exception(
                    logger,
                    "Handler failed",
                    exc=e,
                    handler=handler_name,
                    user_id=user_id,
                )
                raise
            finally:
                elapsed_ms = (time.perf_counter() - started) * 1000
                if elapsed_ms > 500:
                    log_event(
                        logger,
                        logging.INFO,
                        "Slow handler",
                        handler=handler_name,
                        elapsed_ms=round(elapsed_ms, 1),
                    )

        return wrapper  # type: ignore[return-value]

    return decorator


async def run_with_flood_log(
    coro_factory: Callable[[], Any],
    *,
    context: str,
    user_id: int | None = None,
) -> Any:
    """Execute a coroutine and log FloodWait / RPC errors consistently."""
    try:
        return await coro_factory()
    except FloodWaitError as e:
        log_flood_wait(logger, e.seconds, context=context, user_id=user_id)
        raise
    except RPCError as e:
        log_exception(
            logger,
            "Telegram API call failed",
            exc=e,
            context=context,
            user_id=user_id,
            error=type(e).__name__,
        )
        raise
