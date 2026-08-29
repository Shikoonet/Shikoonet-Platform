"""Keyboard builders for admin bulk_increase."""

from telethon import Button

from app.telegram.admin.bulk_increase import states


def panel_selection_buttons(panels) -> list:
    panel_buttons = [
        [Button.inline(f"📡 {panel.name}", data=f"{states.BULK_INCREASE_PANEL_PREFIX}{panel.code}")] for panel in panels
    ]
    panel_buttons.append([Button.inline("🌐 همه پنل‌ها", data=f"{states.BULK_INCREASE_PANEL_PREFIX}all")])
    panel_buttons.append([Button.inline("🔙 بازگشت", data=states.BACK_TO_ADMIN_PANEL)])
    return panel_buttons


def settings_menu_buttons() -> list:
    return [
        [Button.inline("📊 تنظیم حجم", data=states.BULK_INCREASE_SET_VOLUME)],
        [Button.inline("⏰ تنظیم زمان", data=states.BULK_INCREASE_SET_TIME)],
        [Button.inline("✅ تایید و اعمال", data=states.BULK_INCREASE_CONFIRM)],
        [Button.inline("❌ لغو", data=states.BULK_INCREASE_CANCEL)],
    ]


def volume_input_back_button() -> list:
    return [[Button.inline("🔙 بازگشت", data=states.BULK_INCREASE_BACK)]]


def preflight_buttons() -> list:
    return [
        [Button.inline("✅ شروع عملیات", data=states.BULK_INCREASE_APPLY)],
        [Button.inline("❌ لغو", data=states.BULK_INCREASE_CANCEL)],
    ]
