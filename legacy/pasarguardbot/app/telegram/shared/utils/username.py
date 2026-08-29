import re

from httpx import HTTPStatusError
from pasarguard import PasarguardAPI

from app.services.users.identifiers import generate_username
from app.telegram.keyboards.buy import buy_cancel_button, buy_retry_username_button
from app.telegram.state import set_step
from app.utils.text.bot_texts import get_bot_text

USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_]{1,30}[A-Za-z0-9]$")

PANEL_USERNAME_CONFLICT_CODES = frozenset((409, 400, 422))


def is_valid_username(name: str) -> bool:
    return bool(USERNAME_RE.fullmatch(name))


async def generate_unique_username(panel):
    username = generate_username()
    for _ in range(5):
        try:
            await PasarguardAPI(panel.base_url).get_user_by_username(username=username, token=panel.cookie)
            username = generate_username()
        except HTTPStatusError as e:
            if e.response.status_code == 404:
                break
    return username


def is_panel_username_conflict(exc: BaseException) -> bool:
    return isinstance(exc, HTTPStatusError) and exc.response.status_code in PANEL_USERNAME_CONFLICT_CODES


async def handle_buy_username_conflict(event, username: str) -> None:
    alert_text = await get_bot_text(
        key="buy_username_conflict_alert",
        default="نام «{username}» قبلاً در پنل ثبت شده است.",
        lang="fa",
    )
    conflict_text = await get_bot_text(
        key="buy_username_conflict_message",
        default=(
            "❌ **نام کانفیگ `{username}` تکراری است**\n\n"
            "این نام قبلاً توسط ادمین دیگری در پنل ساخته شده است.\n"
            "لطفاً با دکمه زیر نام دیگری انتخاب کنید."
        ),
        lang="fa",
    )
    await event.answer(alert_text.replace("{username}", username), alert=True)
    await event.edit(
        conflict_text.replace("{username}", username),
        buttons=[
            [await buy_retry_username_button()],
            [await buy_cancel_button("DataCancel")],
        ],
        parse_mode="md",
        link_preview=False,
    )
    await set_step(event.sender_id, "enter_username")
