"""Hourly billing for reseller accounts."""

from __future__ import annotations

import contextlib
import json

from pasarguard import AdminModify

from app import Kenzo
from app.db.crud.panels import PanelsManager
from app.db.crud.reseller_accounts import ResellerAccountCRUD
from app.db.crud.reseller_plans import ResellerPlanManager
from app.db.crud.settings import SettingsManager
from app.db.crud.user import UserCRUD, update_Money
from app.logger import get_logger
from app.services.billing.reseller_pricing import resolve_live_unit_price
from app.services.panels.admins import modify_reseller_admin
from app.utils.formatting.dates import Time_Date

log = get_logger(__name__)


async def _resolve_plan(account):
    if not account.plan_id:
        return None
    return await ResellerPlanManager().get_plan(account.plan_id)


async def run_hourly_reseller_billing() -> None:
    settings = await SettingsManager().get_settings()
    if not settings or not settings.reseller_sale_mode:
        return

    accounts = await ResellerAccountCRUD().get_billable_accounts(("hourly",))
    now = Time_Date()["stamp"]

    for account in accounts:
        state = ResellerAccountCRUD.load_billing_state(account.billing_state)
        last_billed = int(state.get("last_billed_at") or account.createtime or now)
        elapsed_hours = max(0, (now - last_billed) // 3600)
        if elapsed_hours <= 0:
            continue

        plan = await _resolve_plan(account)
        hourly_rate = int(resolve_live_unit_price(account, plan))
        if hourly_rate <= 0:
            continue

        charge = int(hourly_rate * elapsed_hours)
        user = await UserCRUD().read_user(account.telegram_id)
        if not user or user.amount < charge:
            panel = await PanelsManager().get_panel_by_code(code=account.panel_code)
            if panel:
                try:
                    await modify_reseller_admin(panel, account.username, AdminModify(status="disabled"))
                except Exception as exc:
                    log.error("suspend hourly reseller failed code=%s: %s", account.code, exc)
            await ResellerAccountCRUD().update_account(account.code, status="suspended")
            with contextlib.suppress(Exception):
                await Kenzo.send_message(
                    account.telegram_id,
                    f"⛔️ نمایندگی `{account.username}` به‌دلیل کمبود موجودی ({charge:,} تومان) تعلیق شد.",
                )
            continue

        await update_Money(user_id=account.telegram_id, Money=-charge)
        state["last_billed_at"] = last_billed + elapsed_hours * 3600
        await ResellerAccountCRUD().update_account(
            account.code,
            billing_state=json.dumps(state, ensure_ascii=False),
            status="active",
        )
