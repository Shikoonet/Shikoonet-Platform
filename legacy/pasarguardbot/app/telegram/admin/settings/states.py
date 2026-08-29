"""State constants for admin settings."""

from app.utils.formatting.conversions import as_int

SETTINGS_PANEL_MENU_MESSAGES = frozenset({"📝 متن‌های ربات", "⌨️ مدیریت دکمه‌های کیبورد"})

SETTINGS_ADMIN_STEPS = frozenset(
    {
        "help_btn_reorder_position",
        "keyboard_btn_set_icon",
        "help_btn_set_icon",
        "help_btn_edit_text",
        "help_btn_edit_link",
        "help_btn_set_text",
        "help_btn_set_url",
    }
)

SETTINGS_CALLBACK_EXACT = frozenset(
    {
        "help_settings_admin",
        "back_to_help_settings",
        "help_settings_reorder_buttons",
        "help_btn_reorder_cancel",
        "help_settings_buttons_ui",
        "help_btn_add",
        "back_to_help_config",
    }
)

SETTINGS_CALLBACK_PREFIXES = (
    "help_btn_reorder_set:",
    "edit_keyboard:",
    "keyboard_btn_edit_text:",
    "keyboard_btn_color:",
    "keyboard_btn_icon:",
    "keyboard_btn_icon_clear:",
    "keyboard_page:",
    "text_sections_page:",
    "text_section:",
    "text_keys_page:",
    "edit_text:",
    "reset_text:",
    "confirm_save_text:",
    "cancel_save_text:",
    "edit_banner_url:",
    "set_banner_position:",
    "help_btn_config:",
    "help_btn_color:",
    "help_btn_icon:",
    "help_btn_icon_clear:",
    "help_btn_edit_text:",
    "help_btn_edit_link:",
    "help_btn_delete:",
    "help_btn_style:",
)

SETTINGS_MENU_PATTERN = rb"^settings_menu(?::[a-z_]+)?$"
SETTINGS_TOGGLE_PREFIX = "settings."
SETTINGS_MENU_MESSAGE_PATTERN = r"^⚙️ تنظیمات ربات$"
SETTINGS_MENU_TRIGGER = "⚙️ تنظیمات ربات"
PANEL_STEP = "panel"


def parse_stored_page(value, default: int = 1) -> int:
    """Parse page numbers from Redis state (may be int or str after json.loads)."""
    page = as_int(value)
    return page if page is not None and page >= 1 else default
