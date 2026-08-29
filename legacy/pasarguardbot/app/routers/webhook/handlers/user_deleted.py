"""
Handler for user_deleted webhook event.
"""

from app.logger import get_logger
from app.models.router_models import WebhookEvent

logger = get_logger(__name__)


async def handle_user_deleted(event: WebhookEvent) -> None:
    """Handle user deleted event."""
    by = event.by.username if event.by else "System/Auto"
    logger.info(f"🗑️ User deleted: {event.username} — Deleted by: {by}")
    # TODO: Add your custom logic here (e.g., cleanup, notification, etc.)
