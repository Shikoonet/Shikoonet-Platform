"""
Handler for user_disabled webhook event.
"""

from app.logger import get_logger
from app.models.router_models import WebhookEvent

logger = get_logger(__name__)


async def handle_user_disabled(event: WebhookEvent) -> None:
    """Handle user disabled event."""
    by = event.by.username if event.by else "System/Auto"
    logger.info(f"🚫 User disabled: {event.username} — Disabled by: {by}")
    if event.reason:
        logger.info(f"   Reason: {event.reason}")
    if event.user:
        logger.info(f"   Status: {event.user.status}")
    # TODO: Add your custom logic here
