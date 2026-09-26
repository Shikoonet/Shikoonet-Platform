"""Keyboard builders for admin log management."""

from app.telegram.admin.logs import states
from app.telegram.keyboards.common import glass_inline_button

BACK_TO_LOG_MANAGEMENT = states.BACK_TO_LOG_MANAGEMENT
BACK_TO_ADMIN_PANEL = states.BACK_TO_ADMIN_PANEL


def main_menu_buttons() -> list:
    rows = []
    log_types = list(states.ALL_LOG_TYPES)
    for i in range(0, len(log_types), 2):
        pair = log_types[i : i + 2]
        rows.append([glass_inline_button(label, data=f"{states.LOG_TYPE_PREFIX}{key}") for key, label in pair])
    rows.append([glass_inline_button("⚡ ست همه لاگ‌ها با یک آیدی", data=states.LOG_SET_ALL)])
    rows.append([glass_inline_button("📊 وضعیت لاگ‌ها", data=states.LOG_SHOW_STATUS)])
    rows.append([glass_inline_button("🔙 بازگشت به پنل", data=BACK_TO_ADMIN_PANEL)])
    return rows


def back_rows() -> list:
    return [[glass_inline_button("🔙 بازگشت", data=BACK_TO_LOG_MANAGEMENT)]]


def back_button() -> list:
    return [glass_inline_button("🔙 بازگشت", data=BACK_TO_LOG_MANAGEMENT)]


def back_to_management_button() -> list:
    return [glass_inline_button("🔙 بازگشت به مدیریت لاگ‌ها", data=BACK_TO_LOG_MANAGEMENT)]


def destination_type_rows(log_type: str) -> list:
    return [
        [glass_inline_button("📢 کانال", data=f"log_dest_channel:{log_type}")],
        [glass_inline_button("👥 سوپرگروه با تایپک", data=f"log_dest_supergroup:{log_type}")],
        [glass_inline_button("🔙 بازگشت", data=BACK_TO_LOG_MANAGEMENT)],
    ]


def set_all_destination_rows() -> list:
    return destination_type_rows(states.SET_ALL_LOG_TYPE)
