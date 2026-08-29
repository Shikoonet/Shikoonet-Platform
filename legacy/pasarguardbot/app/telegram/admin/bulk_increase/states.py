"""State constants for admin bulk_increase."""

BULK_INCREASE_MENU_MESSAGE = "📈 افزایش حجم و زمان همگانی"

BULK_INCREASE_VOLUME_STEP = "bulk_increase_volume"
BULK_INCREASE_TIME_STEP = "bulk_increase_time"
PANEL_STEP = "panel"

STEP_KEY_PANEL = "bulk_increase_panel"
STEP_KEY_VOLUME = "bulk_increase_volume"
STEP_KEY_TIME = "bulk_increase_time"
STEP_KEY_STEP = "bulk_increase_step"
STEP_KEY_LAST_MSG_ID = "bulk_increase_last_msg_id"
STEP_KEY_AFFECTED_USERS = "bulk_increase_affected_users"
STEP_KEY_VOLUME_TEXT = "bulk_increase_volume_text"
STEP_KEY_TIME_TEXT = "bulk_increase_time_text"
STEP_KEY_TOTAL_VOLUME = "bulk_increase_total_volume"
STEP_KEY_TOTAL_TIME = "bulk_increase_total_time"

STEP_KEYS = (
    STEP_KEY_PANEL,
    STEP_KEY_VOLUME,
    STEP_KEY_TIME,
    STEP_KEY_STEP,
    STEP_KEY_LAST_MSG_ID,
    STEP_KEY_AFFECTED_USERS,
    STEP_KEY_VOLUME_TEXT,
    STEP_KEY_TIME_TEXT,
    STEP_KEY_TOTAL_VOLUME,
    STEP_KEY_TOTAL_TIME,
)

BULK_INCREASE_PANEL_PREFIX = "bulk_increase_panel:"
BULK_INCREASE_SET_VOLUME = "bulk_increase_set_volume"
BULK_INCREASE_SET_TIME = "bulk_increase_set_time"
BULK_INCREASE_CONFIRM = "bulk_increase_confirm"
BULK_INCREASE_CANCEL = "bulk_increase_cancel"
BULK_INCREASE_BACK = "bulk_increase_back"
BULK_INCREASE_APPLY = "bulk_increase_apply"
BACK_TO_ADMIN_PANEL = "back_to_admin_panel"

BULK_INCREASE_CALLBACK_PREFIXES = (
    BULK_INCREASE_PANEL_PREFIX,
    "bulk_increase_",
)

PROGRESS_EDIT_INTERVAL = 10
MAX_ERROR_DETAILS = 10
