"""
Handler for user_updated webhook event.
"""

from app.logger import get_logger
from app.models.router_models import WebhookEvent

logger = get_logger(__name__)


async def handle_user_updated(event: WebhookEvent) -> None:
    """Handle user updated event."""
    logger.info(f"🔄 User updated: {event.username}")
    if event.user:
        logger.info(f"   User ID: {event.user.id}")
        logger.info(f"   Status: {event.user.status}")
        logger.info(f"   Used Traffic: {event.user.used_traffic} bytes")
        if event.user.data_limit:
            remaining = event.user.data_limit - event.user.used_traffic
            logger.info(f"   Remaining Traffic: {remaining} bytes")
    # TODO: Add your custom logic here
