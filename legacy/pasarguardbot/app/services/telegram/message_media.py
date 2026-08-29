"""Classify Telethon message media for payload capture and Rich Message eligibility."""

from __future__ import annotations

from telethon.tl.types import MessageMediaWebPage

_LINK_PREVIEW_MEDIA = (MessageMediaWebPage,)


def is_link_preview_media(media) -> bool:
    return isinstance(media, _LINK_PREVIEW_MEDIA)


def has_file_media(media) -> bool:
    """True when media is a real attachment (photo, video, file, …), not link preview."""
    if media is None:
        return False
    return not is_link_preview_media(media)


def message_has_file_media(message) -> bool:
    return has_file_media(getattr(message, "media", None))
