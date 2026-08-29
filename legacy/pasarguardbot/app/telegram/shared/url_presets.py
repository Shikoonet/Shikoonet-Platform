"""Ready-made bot deep-link presets for admin link helpers."""

from __future__ import annotations

from app.telegram.shared.start_params import (
    get_documented_param_order,
    get_documented_start_params,
)

_documented = get_documented_start_params()

URL_PRESET_KEYS = get_documented_param_order()

URL_PRESET_LABELS = {key: _documented[key][0] for key in URL_PRESET_KEYS}

URL_PRESET_DESCRIPTIONS = {key: _documented[key][1] for key in URL_PRESET_KEYS}


async def get_bot_username(client) -> str:
    try:
        me = await client.get_me()
        if me and me.username:
            return me.username
    except Exception:
        pass
    return "bott"


def build_preset_url(bot_username: str, preset_key: str) -> str:
    return f"https://t.me/{bot_username}?start={preset_key}"


def format_admin_links_message(bot_username: str) -> str:
    lines = ["🔗 **لینک‌های آماده ربات:**\n"]

    lines.append("**▫️ اصلی**")
    for key in ("start", "free", "buy", "charge"):
        label, desc = _documented[key]
        lines.append(f"**{label}** — {desc}\n`{build_preset_url(bot_username, key)}`\n")

    app_keys = [key for key in URL_PRESET_KEYS if key not in ("start", "free", "buy", "charge")]
    if app_keys:
        lines.append("**▫️ دانلود اپ**")
        for key in app_keys:
            label, desc = _documented[key]
            lines.append(f"**{label}** — {desc}\n`{build_preset_url(bot_username, key)}`\n")

    lines.append("\n💡 پارامترهای نامعتبر یا قدیمی (مثل `kenzo`) منوی اصلی را نشان می‌دهند.")
    lines.append("💡 می‌توانید این لینک‌ها را در پیام‌ها یا دکمه URL استفاده کنید.")
    return "\n".join(lines)
