"""State constants for admin wallets."""

BALANCE_ADMIN_STEPS = frozenset(
    {
        "addMoney",
        "amount_username",
        "KasrMoney",
        "Kasr_amount_username",
        "group_charge_amount",
    }
)

BALANCE_MENU_MESSAGES = frozenset(
    {
        "➕ افزودن موجودی",
        "➖ کسر موجودی",
        "💰 شارژ گروهی",
        "🔄 ریست دریافت تست",
    }
)

WALLET_MANAGEMENT_CALLBACK = "wallet_management"
BACK_TO_SETTINGS_CARD_CALLBACK = "BackTOSettingsCardToCard"
BACK_TO_ADMIN_PANEL_CALLBACK = "back_to_admin_panel"

ADD_WALLET_ADDRESS_STEP = "add_wallet_address"
ADD_WALLET_API_KEY_STEP = "add_wallet_api_key"
EDIT_WALLET_ADDRESS_STEP = "edit_wallet_address"
EDIT_WALLET_API_KEY_STEP = "edit_wallet_api_key"
DELETE_WALLET_SELECT_STEP = "delete_wallet_select"
SETTINGS_CARD_TO_CARD_STEP = "SettingsCardToCard"

GROUP_CHARGE_AMOUNT_STEP = "group_charge_amount"
