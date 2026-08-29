"""Keyboard builders for admin help management."""

from __future__ import annotations

from telethon import Button

from app.telegram.admin.help import texts
from app.telegram.shared.utils.help_download import target_edit_buttons


def apps_manage_rows(apps_list) -> list:
    rows = []
    for app in apps_list:
        rows.append(
            [
                Button.inline(f"📱 {app.button_text}", data=f"help_download_app_config:{app.id}"),
                Button.inline("🗑", data=f"help_download_app_del:{app.id}"),
            ]
        )
    rows.append([Button.inline("➕ افزودن اپ", data="help_download_app_add")])
    rows.append([Button.inline("📝 متن/لینک فقط", data="help_download_app_add_text")])
    rows.append([Button.inline("📋 اپ‌های پیش‌فرض", data="help_download_app_add_defaults")])
    rows.append([Button.inline("🔙 بازگشت", data="back_to_help_settings")])
    return rows


def cancel_row() -> list:
    return [Button.inline("❌ انصراف", data="help_download_app_cancel")]


def back_to_config_row(app_id: int) -> list:
    return [Button.inline("🔙 بازگشت", data=f"help_download_app_config:{app_id}")]


def back_to_targets_row(app_id: int) -> list:
    return [Button.inline("🔙 بازگشت", data=f"help_download_app_targets:{app_id}")]


def back_to_target_row(app_id: int, target_id: str) -> list:
    return [Button.inline("🔙 بازگشت", data=f"help_download_app_target:{app_id}:{target_id}")]


def back_to_apps_manage_row() -> list:
    return [Button.inline("📦 بازگشت به لیست اپ‌ها", data="help_download_apps_manage")]


def ios_skip_rows() -> list:
    return [
        [Button.inline("⏭ بدون لینک iOS", data="help_download_app_ios_skip")],
        cancel_row(),
    ]


def category_selection_rows() -> list:
    return [
        [Button.inline("✅ پیش‌فرض (همه پلتفرم‌ها)", data="help_download_app_cat:default")],
        [Button.inline("📱 فقط اندروید", data="help_download_app_cat:android")],
        cancel_row(),
    ]


def target_edit_screen(app_id: int, target: dict) -> tuple[str, list]:
    return texts.target_edit_text(target), target_edit_buttons(app_id, target["id"])
