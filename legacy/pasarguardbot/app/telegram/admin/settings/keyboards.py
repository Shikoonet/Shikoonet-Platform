"""Keyboard builders for admin settings."""

from telethon import Button


def help_settings_menu_buttons():
    return [
        [Button.inline("✏️ تنظیم دکمه‌های راهنما", data="help_settings_buttons_ui")],
        [Button.inline("📐 اولویت نمایش دکمه‌ها", data="help_settings_reorder_buttons")],
        [Button.inline("📦 مدیریت اپ‌های دانلود", data="help_download_apps_manage")],
        [Button.inline("🔙 بازگشت به راهنما", data="backTOhelp")],
    ]
