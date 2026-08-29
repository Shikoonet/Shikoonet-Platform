"""Register global Telethon handlers that run the middleware pipeline."""

from __future__ import annotations

from telethon import events

from app import Kenzo
from app.telegram.middlewares.base import StopPipeline
from app.telegram.middlewares.context import MiddlewareContext
from app.telegram.middlewares.manager import (
    PIPELINE_CALLBACK,
    PIPELINE_NEWMESSAGE,
    middleware_manager,
)


async def _execute_pipeline(event, pipeline: str) -> None:
    ctx = MiddlewareContext.from_event(event)
    try:
        await middleware_manager.run_before(ctx, pipeline)
    except StopPipeline:
        raise events.StopPropagation from None


@Kenzo.on(events.NewMessage(incoming=True))
async def middleware_newmessage_handler(event):
    await _execute_pipeline(event, PIPELINE_NEWMESSAGE)


@Kenzo.on(events.CallbackQuery())
async def middleware_callback_handler(event):
    await _execute_pipeline(event, PIPELINE_CALLBACK)
