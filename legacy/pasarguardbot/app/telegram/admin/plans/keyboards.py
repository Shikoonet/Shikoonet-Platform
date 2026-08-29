"""Keyboard builders for admin plans."""

from telethon import Button


def plan_main_menu_buttons():
    return [
        [Button.inline("➕ ساخت پلن جدید", data="PlanAddSelectPanel")],
        [Button.inline("📋 مدیریت پلن‌ها", data="PlanManageSelectPanel")],
        [Button.inline("❌ بستن منو ❌", data="DataCancelPlans")],
    ]


def add_plan_back_buttons():
    return [
        [
            Button.inline("🔙 بازگشت به منوی پلن", data="BackToPlanMainMenu"),
            Button.inline("🔙 بازگشت", data="BackToVolumeInput"),
        ],
    ]


def time_input_back_buttons():
    return [
        [
            Button.inline("🔙 بازگشت به منوی پلن", data="BackToPlanMainMenu"),
            Button.inline("🔙 بازگشت", data="BackToTimeInput"),
        ],
    ]


def price_input_back_buttons():
    return [
        [
            Button.inline("🔙 بازگشت به منوی پلن", data="BackToPlanMainMenu"),
            Button.inline("🔙 بازگشت", data="BackToPriceInput"),
        ],
    ]


def ip_limit_back_buttons():
    return [
        [
            Button.inline("🔙 بازگشت به منوی پلن", data="BackToPlanMainMenu"),
            Button.inline("🔙 بازگشت", data="BackToIPLimitInput"),
        ],
    ]
