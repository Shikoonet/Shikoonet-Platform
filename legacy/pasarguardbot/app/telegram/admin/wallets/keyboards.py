"""Keyboard builders for admin wallets."""

from telethon import Button

from app.db.crud.wallets import WalletCRUD
from app.telegram.admin.wallets import states
from app.telegram.keyboards.common import glass_inline_button


async def wallets_menu_buttons():
    """Get the wallets menu buttons"""
    wallets = await WalletCRUD().get_all_wallets()
    buttons = [
        [Button.inline("➕ افزودن کیف پول", data="add_wallet")],
    ]

    if wallets:
        buttons.append([Button.inline("📋 لیست کیف پول‌ها", data="list_wallets")])
        buttons.append([Button.inline("✏️ ویرایش کیف پول", data="edit_wallet_menu")])
        buttons.append([Button.inline("🗑 حذف کیف پول", data="delete_wallet_menu")])

    buttons.append([Button.inline("🔙 بازگشت", data=states.BACK_TO_SETTINGS_CARD_CALLBACK)])
    return buttons


def wallet_management_back_button():
    return [[Button.inline("🔙 بازگشت", data=states.WALLET_MANAGEMENT_CALLBACK)]]


def wallet_type_buttons(existing_types: set[str]):
    buttons = []
    if "TRX" not in existing_types:
        buttons.append([Button.inline("🟢 TRX (Tron)", data="select_wallet_type:TRX")])
    if "USDT" not in existing_types:
        buttons.append([Button.inline("💵 USDT (Tether)", data="select_wallet_type:USDT")])
    if "TON" not in existing_types:
        buttons.append([Button.inline("🔵 TON (Toncoin)", data="select_wallet_type:TON")])
    return buttons


def edit_wallet_type_buttons(wallet_id: int, existing_types: set[str], current_type: str):
    buttons = []
    buttons.append(
        [Button.inline(f"✅ {current_type} (فعلی)", data=f"edit_select_wallet_type:{wallet_id}:{current_type}")]
    )
    if "TRX" not in existing_types and current_type != "TRX":
        buttons.append([Button.inline("🟢 TRX (Tron)", data=f"edit_select_wallet_type:{wallet_id}:TRX")])
    if "USDT" not in existing_types and current_type != "USDT":
        buttons.append([Button.inline("💵 USDT (Tether)", data=f"edit_select_wallet_type:{wallet_id}:USDT")])
    if "TON" not in existing_types and current_type != "TON":
        buttons.append([Button.inline("🔵 TON (Toncoin)", data=f"edit_select_wallet_type:{wallet_id}:TON")])
    buttons.append([Button.inline("🔙 بازگشت", data=states.WALLET_MANAGEMENT_CALLBACK)])
    return buttons


def wallet_action_list_buttons(wallets, action_prefix: str):
    buttons = [[Button.inline(f"{w.type} - {w.address[:30]}...", f"{action_prefix}:{w.id}")] for w in wallets]
    buttons.append([Button.inline("🔙 بازگشت", data=states.WALLET_MANAGEMENT_CALLBACK)])
    return buttons


def user_new_balance_button(new_amount: int):
    return [Button.inline(f"💰 موجودی جدید شما: {int(new_amount):,} تومان", "no_action")]


def group_charge_menu_buttons():
    return [
        [Button.inline("👥 تمام کاربرها", data="group_charge:all")],
        [Button.inline("✅ کاربرهای دارای سرویس فعال", data="group_charge:active_service")],
        [Button.inline("🔙 بازگشت", data=states.BACK_TO_ADMIN_PANEL_CALLBACK)],
    ]


def group_reset_menu_buttons():
    return [
        [Button.inline("👥 تمام کاربرها", data="group_reset:all")],
        [Button.inline("✅ کاربرهای دارای سرویس فعال", data="group_reset:active_service")],
        [Button.inline("🔙 بازگشت", data=states.BACK_TO_ADMIN_PANEL_CALLBACK)],
    ]


def group_charge_confirm_buttons(charge_type: str, amount: int):
    return [
        [glass_inline_button("✅ تایید", data=f"group_charge_confirm:{charge_type}:{amount}")],
        [glass_inline_button("❌ رد", data="group_charge_cancel")],
    ]


def group_reset_confirm_buttons(reset_type: str):
    return [
        [Button.inline("✅ تایید", data=f"group_reset_confirm:{reset_type}")],
        [Button.inline("❌ رد", data="group_reset_cancel")],
    ]


def group_charge_back_button():
    return [[Button.inline("🔙 بازگشت", data=states.BACK_TO_ADMIN_PANEL_CALLBACK)]]
