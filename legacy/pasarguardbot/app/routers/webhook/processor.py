"""
Webhook event processor - routes events to appropriate handlers.
"""

from typing import Any

from app.logger import get_logger
from app.models.router_models import WebhookEvent
from app.routers.webhook.handlers import (
    handle_days_left_reached,
    handle_usage_percent_reached,
    handle_user_created,
    handle_user_deleted,
    handle_user_disabled,
    handle_user_enabled,
    handle_user_expired,
    handle_user_limited,
    handle_user_updated,
)

logger = get_logger(__name__)


async def process_webhook_events(events: list[dict[str, Any]]) -> None:
    """Process a list of webhook events."""

    for event_data in events:
        try:
            event = WebhookEvent(**event_data)
            await handle_event(event)
        except Exception as e:
            logger.error(f"Failed to process webhook event: {e}")
            logger.debug(f"Event data: {event_data}")


async def handle_event(event: WebhookEvent) -> None:
    """Handle a single webhook event."""

    event_handlers = {
        "user_created": handle_user_created,
        "user_updated": handle_user_updated,
        "user_deleted": handle_user_deleted,
        "user_limited": handle_user_limited,
        "user_expired": handle_user_expired,
        "user_disabled": handle_user_disabled,
        "user_enabled": handle_user_enabled,
        "reached_days_left": handle_days_left_reached,
        "reached_usage_percent": handle_usage_percent_reached,
    }

    handler = event_handlers.get(event.action)
    if handler:
        await handler(event)
    else:
        logger.warning(f"Unknown webhook action: {event.action}")
