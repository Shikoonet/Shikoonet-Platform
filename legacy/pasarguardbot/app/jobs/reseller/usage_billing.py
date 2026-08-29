"""Usage-based billing for reseller accounts."""

from __future__ import annotations

import contextlib
import json

from pasarguard import AdminModify

from app import Kenzo
from app.db.crud.panels import PanelsManager
from app.db.crud.reseller_accounts import ResellerAccountCRUD
from app.db.crud.reseller_billing_snapshots import ResellerBillingSnapshotCRUD
from app.db.crud.reseller_plans import ResellerPlanManager
from app.db.crud.settings import SettingsManager
from app.db.crud.user import UserCRUD, update_Money
from app.logger import get_logger
from app.services.billing.reseller_pricing import resolve_live_unit_price
from app.services.panels.admins import get_reseller_admin, modify_reseller_admin
from app.utils.formatting.conversions import gigabytes_to_bytes
from app.utils.formatting.dates import Time_Date

log = get_logger(__name__)


async def _resolve_plan(account):
    if not account.plan_id:
        return None
    return await ResellerPlanManager().get_plan(account.plan_id)


async def run_usage_reseller_billing() -> None:
    settings = await SettingsManager().get_settings()
    if not settings:
        return

    accounts = await ResellerAccountCRUD().get_billable_accounts(("usage",))
    snapshot_crud = ResellerBillingSnapshotCRUD()
    now = Time_Date()["stamp"]

    for account in accounts:
        panel = await PanelsManager().get_panel_by_code(code=account.panel_code)
        if not panel:
            continue

        admin = await get_reseller_admin(panel, account.username)
        if not admin:
            continue

        used_traffic = int(getattr(admin, "used_traffic", 0) or 0)
        snapshot = await snapshot_crud.get_latest_snapshot(account.code)
        last_used = int(snapshot.used_traffic if snapshot else 0)
        delta_bytes = max(0, used_traffic - last_used)
        if delta_bytes <= 0:
            continue

        delta_gb = delta_bytes / gigabytes_to_bytes(1)
        plan = await _resolve_plan(account)
        rate = resolve_live_unit_price(account, plan)
        charge = round(delta_gb * rate)
        if charge <= 0:
            await snapshot_crud.add_snapshot(account.code, used_traffic, 0, now)
            continue

        user = await UserCRUD().read_user(account.telegram_id)
        balance = user.amount if user else 0
        if not user or balance < charge:
            try:
                await modify_reseller_admin(panel, account.username, AdminModify(status="disabled"))
            except Exception as exc:
                log.error("suspend usage reseller failed code=%s: %s", account.code, exc)
            await ResellerAccountCRUD().update_account(account.code, status="suspended")
            with contextlib.suppress(Exception):
                await Kenzo.send_message(
                    account.telegram_id,
                    f"⛔️ نمایندگی `{account.username}` به‌دلیل کمبود موجودی برای billing مصرفی تعلیق شد.",
                )
            continue

        await update_Money(user_id=account.telegram_id, Money=-charge)
        state = ResellerAccountCRUD.load_billing_state(account.billing_state)
        state["last_used_traffic"] = used_traffic
        await ResellerAccountCRUD().update_account(
            account.code,
            billing_state=json.dumps(state, ensure_ascii=False),
        )
        await snapshot_crud.add_snapshot(account.code, used_traffic, charge, now)
