"""
Handler for user_created webhook event.
"""

from app.logger import get_logger
from app.models.router_models import WebhookEvent

logger = get_logger(__name__)


async def handle_user_created(event: WebhookEvent) -> None:
    """Handle user created event."""
    logger.info(f"✅ User created: {event.username}")
    if event.user:
        logger.info(f"   User ID: {event.user.id}")
        logger.info(f"   Status: {event.user.status}")
        logger.info(
            f"   Data Limit: {event.user.data_limit} bytes" if event.user.data_limit else "   Data Limit: Unlimited"
        )
        logger.info(f"   Expire: {event.user.expire}" if event.user.expire else "   Expire: Never")
        logger.info(f"   Subscription URL: {event.user.subscription_url}" if event.user.subscription_url else "")
    # TODO: Add your custom logic here (e.g., send notification, update database, etc.)
