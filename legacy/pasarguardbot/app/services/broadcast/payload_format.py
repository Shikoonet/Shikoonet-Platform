"""Message type helpers for broadcast payloads (normal vs rich)."""

from __future__ import annotations

FORMAT_LABELS: dict[str | None, str] = {
    None: "عادی",
    "rich": "✨ Rich",
}


def format_label(mode: str | None) -> str:
    return FORMAT_LABELS.get("rich" if mode == "rich" else None, "عادی")


def is_text_only_payload(payload: dict) -> bool:
    if payload.get("is_forward"):
        return False
    if payload.get("media"):
        return False
    if payload.get("message_ids") and payload.get("from_chat"):
        return False
    return bool(str(payload.get("text") or "").strip())


def supports_rich_format(payload: dict) -> bool:
    return is_text_only_payload(payload)


def selectable_types(payload: dict) -> tuple[str, ...]:
    if supports_rich_format(payload):
        return ("normal", "rich")
    return ("normal",)


def set_message_type(payload: dict, mode: str) -> tuple[dict, str | None]:
    """Set payload to normal (Telegram default) or rich text-only mode."""
    updated = dict(payload)
    if mode == "rich":
        if not supports_rich_format(updated):
            return updated, "Rich Message فقط برای پیام متنی پشتیبانی می‌شود."
        updated["parse_mode"] = "rich"
    else:
        updated.pop("parse_mode", None)
    return updated, None
