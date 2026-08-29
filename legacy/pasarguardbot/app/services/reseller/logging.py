"""Centralized reseller activity logging to the configured log channel."""

from __future__ import annotations

import random
from typing import TYPE_CHECKING

from telethon.tl import functions, types

from app import Kenzo
from app.db.crud.panels import PanelsManager
from app.db.crud.reseller_plans import ResellerPlanManager
from app.logger import LogType, get_logger
from app.services.billing.reseller_pricing import pricing_mode_label
from app.services.telegram.rich_message import prepare_rich_markdown
from app.telegram.shared.utils.logging import send_log_message
from app.utils.formatting.dates import timestamp_to_persian_expiry
from app.utils.formatting.traffic import format_size

if TYPE_CHECKING:
    from app.db.models.reseller_accounts import ResellerAccount

log = get_logger(__name__)


async def _account_context_lines(account: ResellerAccount) -> list[str]:
    panel = await PanelsManager().get_panel_by_code(code=account.panel_code)
    panel_name = panel.name if panel else "—"
    plan = await ResellerPlanManager().get_plan(account.plan_id) if account.plan_id else None

    lines = [
        f"👤 <b>کاربر:</b> <code>{account.telegram_id}</code>",
        f"🎫 <b>کد نمایندگی:</b> <code>{account.code}</code>",
        f"🏢 <b>یوزر ادمین:</b> <code>{account.username}</code>",
        f"📛 <b>پنل:</b> {panel_name} (<code>{account.panel_code}</code>)",
        f"📋 <b>نوع پلن:</b> {pricing_mode_label(account.pricing_mode)}",
        f"📊 <b>وضعیت:</b> <code>{account.status}</code>",
    ]
    if plan:
        lines.append(f"📦 <b>پلن:</b> #{plan.id}")
    if account.purchased_volume:
        lines.append(f"📦 <b>حجم خرید:</b> {account.purchased_volume:g}")
    if account.data_limit:
        lines.append(f"📥 <b>سقف ترافیک:</b> {format_size(account.data_limit)}")
    if account.max_users:
        lines.append(f"👥 <b>سقف یوزر:</b> {account.max_users}")
    if account.expiration_time:
        lines.append(f"⏰ <b>انقضا:</b> {timestamp_to_persian_expiry(account.expiration_time)}")
    return lines


async def send_reseller_log(
    title: str,
    *,
    account: ResellerAccount | None = None,
    actor_id: int | None = None,
    actor_role: str | None = None,
    extra_lines: list[str] | None = None,
) -> None:
    parts = [f"<b>{title}</b>", ""]
    if actor_id is not None:
        role = actor_role or "کاربر"
        parts.append(f"👮 <b>انجام‌دهنده:</b> <code>{actor_id}</code> ({role})")
        parts.append("")
    if account is not None:
        parts.extend(await _account_context_lines(account))
        parts.append("")
    if extra_lines:
        parts.extend(line for line in extra_lines if line)

    message = "\n".join(parts).strip()
    await send_log_message(LogType.RESELLER, message=message, parse_mode="html")


def _truncate_fixed(value: str, width: int) -> str:
    text = (value or "").strip()
    if len(text) <= width:
        return text.ljust(width)
    if width <= 1:
        return text[:width]
    return (text[: width - 1] + "…").ljust(width)


def _format_usage_compact(size_bytes: int | None) -> str:
    raw = int(size_bytes or 0)
    if raw < 1024:
        return f"{raw} B"
    if raw < 1024**2:
        return f"{raw / 1024:.2f} KB"
    if raw < 1024**3:
        return f"{raw / (1024**2):.2f} MB"
    return f"{raw / (1024**3):.3f} GB"


async def send_reseller_usage_charge_table(rows: list[dict]) -> None:
    if not rows:
        return

    # Keep the newest 150 rows to avoid noisy minute-by-minute log spam.
    rows = rows[-150:]
    header = "📊 <b>Reseller Usage Charge Summary</b>"
    summary = f"🧾 <b>Rows:</b> <code>{len(rows)}</code> (last 150)"

    table_lines = [
        "Code    | Admin            | TelegramID  | Panel  | Status   | MaxUsers | Usage       | Charge(TMN)",
        "--------+------------------+-------------+--------+----------+----------+-------------+------------",
    ]
    markdown_rows: list[str] = []
    for row in rows:
        code = _truncate_fixed(str(row.get("code", "")), 7)
        username = _truncate_fixed(str(row.get("username", "")), 16)
        telegram_id = _truncate_fixed(str(row.get("telegram_id", "")), 11)
        panel_code = _truncate_fixed(str(row.get("panel_code", "")), 6)
        status = _truncate_fixed(str(row.get("status", "")), 8)
        max_users = _truncate_fixed(str(row.get("max_users", "")), 8)
        usage = _truncate_fixed(_format_usage_compact(row.get("usage_bytes")), 11)
        charge = _truncate_fixed(str(row.get("charge", "")), 10)
        table_lines.append(
            f"{code} | {username} | {telegram_id} | {panel_code} | {status} | {max_users} | {usage} | {charge}"
        )
        markdown_rows.append(
            "| "
            + " | ".join(
                [
                    str(row.get("code", "")),
                    str(row.get("username", "")),
                    str(row.get("telegram_id", "")),
                    str(row.get("panel_code", "")),
                    str(row.get("status", "")),
                    str(row.get("max_users", "")),
                    _format_usage_compact(row.get("usage_bytes")),
                    str(row.get("charge", "")),
                ]
            )
            + " |"
        )

    markdown = "\n".join(
        [
            "# 📊 Reseller Usage Charge Summary",
            "",
            f"**🧾 Rows:** `{len(rows)}` *(last 150)*",
            "",
            "<details>",
            "<summary>📋 Usage Table</summary>",
            "",
            "| Code | Admin | TelegramID | Panel | Status | MaxUsers | Usage | Charge(TMN) |",
            "|------|-------|------------|-------|--------|----------|-------|-------------|",
            *markdown_rows,
            "",
            "</details>",
        ]
    )
    from app.db.crud.log_channels import LogChannelManager
    from config import LOG_CHANNEL

    chat_id = None
    topic_id = None
    try:
        destination = await LogChannelManager().get_log_channel_destination(LogType.RESELLER.value)
        if destination:
            chat_id = int(destination["chat_id"])
            topic_id = int(destination["topic_id"]) if destination.get("topic_id") else None
        elif LOG_CHANNEL is not None:
            chat_id = int(LOG_CHANNEL)
    except Exception as exc:
        log.error("resolve reseller log destination failed: %s", exc)

    if chat_id is not None:
        try:
            request_kwargs = {
                "peer": chat_id,
                "message": "",
                "rich_message": types.InputRichMessageMarkdown(prepare_rich_markdown(markdown), rtl=True),
                "random_id": random.getrandbits(63),
            }
            if topic_id:
                request_kwargs["reply_to"] = topic_id
            await Kenzo(functions.messages.SendMessageRequest(**request_kwargs))
            return
        except Exception as exc:
            log.error("reseller usage rich log send failed: %s", exc)

    message = "\n".join([header, "", summary, "", "<pre>", *table_lines, "</pre>"])
    await send_log_message(LogType.RESELLER, message=message, parse_mode="html")
