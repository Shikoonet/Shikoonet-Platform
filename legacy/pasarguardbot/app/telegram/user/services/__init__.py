"""Compatibility exports for the user services module."""

from app.services.panels.config_links import fetch_user_config_links as fetch_user_config_links
from app.telegram.user.services import states
from app.telegram.user.services.callbacks import service_callback_handler as service_callback_handler
from app.telegram.user.services.helpers import (
    build_service_info_message_text as build_service_info_message_text,
    build_service_text as build_service_text,
    check_user_balance as check_user_balance,
    create_balance_button as create_balance_button,
    display_subscription_clients as display_subscription_clients,
    display_subscription_links as display_subscription_links,
    display_usage_chart as display_usage_chart,
    display_usage_chart_day as display_usage_chart_day,
    display_user_services as display_user_services,
    edit_service_view as edit_service_view,
    generate_volume_buttons_tamdid as generate_volume_buttons_tamdid,
    group_durations as group_durations,
)

SUB_LINKS_PAGE_LIMIT = states.SUB_LINKS_PAGE_LIMIT
BYTES_IN_GB = states.BYTES_IN_GB

__all__ = [
    "BYTES_IN_GB",
    "SUB_LINKS_PAGE_LIMIT",
    "build_service_info_message_text",
    "build_service_text",
    "check_user_balance",
    "create_balance_button",
    "display_subscription_clients",
    "display_subscription_links",
    "display_usage_chart",
    "display_usage_chart_day",
    "display_user_services",
    "edit_service_view",
    "fetch_user_config_links",
    "generate_volume_buttons_tamdid",
    "group_durations",
    "service_callback_handler",
    "states",
]
