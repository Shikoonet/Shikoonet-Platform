"""
Handler for user_enabled webhook event.
"""

from app.logger import get_logger
from app.models.router_models import WebhookEvent

logger = get_logger(__name__)


async def handle_user_enabled(event: WebhookEvent) -> None:
    """Handle user enabled event."""
    by = event.by.username if event.by else "System/Auto"
    logger.info(f"✅ User enabled: {event.username} — Enabled by: {by}")
    if event.user:
        logger.info(f"   Status: {event.user.status}")
    # TODO: Add your custom logic here
