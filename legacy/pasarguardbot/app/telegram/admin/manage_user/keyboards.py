"""Keyboard builders for admin manage_user."""

from telethon import Button

from app.telegram.admin.manage_user import texts


def back_to_panel_button():
    return [Button.text(texts.BACK_TO_PANEL_LABEL, resize=True)]
