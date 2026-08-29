"""Helpers for streaming Telegram message drafts."""

from __future__ import annotations

import asyncio
import random
from typing import Any

from telethon import functions, types


def _progressive_message_parts(message: str, max_parts: int = 3) -> list[str]:
    lines = list(message.splitlines())
    if len(lines) <= 1:
        return [message]

    parts: list[str] = []
    total = len(lines)
    for index in range(1, max_parts + 1):
        end = max(1, round(total * index / max_parts))
        part = "\n".join(lines[:end]).strip()
        if part and (not parts or parts[-1] != part):
            parts.append(part)

    if parts[-1] != message:
        parts.append(message)
    return parts


def _text_with_entities(message: str, parse_mode: Any | None):
    if parse_mode is None:
        return types.TextWithEntities(text=message, entities=[])

    text, entities = parse_mode.parse(message)
    return types.TextWithEntities(text=text, entities=entities or [])


async def send_message_draft(
    client,
    peer,
    message: str,
    *,
    parse_mode: Any | None = None,
    delay: float = 0.8,
    max_parts: int = 3,
    logger: Any | None = None,
) -> bool:
    action_cls = getattr(types, "SendMessageTextDraftAction", None)
    if action_cls is None or not hasattr(types, "TextWithEntities"):
        if logger is not None:
            logger.debug("Telethon does not expose SendMessageTextDraftAction/TextWithEntities")
        return False

    draft_id = random.getrandbits(63) or 1
    for part in _progressive_message_parts(message, max_parts=max_parts):
        try:
            await client(
                functions.messages.SetTypingRequest(
                    peer=peer,
                    action=action_cls(
                        text=_text_with_entities(part, parse_mode),
                        random_id=draft_id,
                    ),
                )
            )
        except Exception as e:
            if logger is not None:
                logger.debug("Could not stream message draft: %s", e)
            return False
        await asyncio.sleep(delay)

    return True
