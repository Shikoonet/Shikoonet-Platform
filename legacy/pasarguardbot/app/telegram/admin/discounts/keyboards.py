"""Inline keyboards for admin discount code management."""

from __future__ import annotations

from telethon import Button

BACK_TO_DISCOUNT_MENU = "discount_back_menu"
BACK_TO_DISCOUNT_LIST = "BackToTakhfifList"
DISCOUNT_LIST = "discount_list"
DISCOUNT_CREATE = "discount_create"
DISCOUNT_STATS = "discount_stats"
BACK_TO_ADMIN_PANEL = "discount_back_admin"

CREATE_BACK_FROM_DAYS = "discount_create_back_from_days"
CREATE_BACK_DAYS = "discount_create_back_days"
CREATE_BACK_LIMIT = "discount_create_back_limit"
CREATE_BACK_PERCENT = "discount_create_back_percent"


def _back_row(data: str):
    return [Button.inline("🔙 بازگشت", data=data)]


def main_menu_buttons():
    return [
        [Button.inline("📊 آمارگیری کدهای تخفیف", data=DISCOUNT_STATS)],
        [
            Button.inline("🎛 لیست کدتخفیف", data=DISCOUNT_LIST),
            Button.inline("🪄 ساخت کدتخفیف", data=DISCOUNT_CREATE),
        ],
        [Button.inline("🔙 بازگشت به پنل", data=BACK_TO_ADMIN_PANEL)],
    ]


def stats_buttons():
    return [
        [Button.inline("🔄 بروزرسانی آمار", data=DISCOUNT_STATS)],
        [Button.inline("🔙 بازگشت", data=BACK_TO_DISCOUNT_MENU)],
    ]


def create_type_buttons():
    return [
        [Button.inline("🌍 عمومی", data="discount_type_public")],
        [Button.inline("💎 پرایوت", data="discount_type_private")],
        [Button.inline("🛠 کد سفارشی", data="discount_custom_start")],
        _back_row(BACK_TO_DISCOUNT_MENU),
    ]


def days_buttons():
    return [
        [
            Button.inline("1 ساعت", data="discount_hours_1"),
            Button.inline("3 ساعت", data="discount_hours_3"),
            Button.inline("6 ساعت", data="discount_hours_6"),
        ],
        [
            Button.inline("12 ساعت", data="discount_hours_12"),
            Button.inline("24 ساعت", data="discount_hours_24"),
        ],
        [
            Button.inline("1 روز", data="discount_days_1"),
            Button.inline("2 روز", data="discount_days_2"),
            Button.inline("3 روز", data="discount_days_3"),
        ],
        [
            Button.inline("4 روز", data="discount_days_4"),
            Button.inline("5 روز", data="discount_days_5"),
            Button.inline("6 روز", data="discount_days_6"),
            Button.inline("7 روز", data="discount_days_7"),
        ],
        [
            Button.inline("30 روز", data="discount_days_30"),
            Button.inline("60 روز", data="discount_days_60"),
            Button.inline("90 روز", data="discount_days_90"),
        ],
        [
            Button.inline("180 روز", data="discount_days_180"),
            Button.inline("365 روز", data="discount_days_365"),
        ],
        [Button.inline("🎯 دلخواه", data="discount_days_custom")],
        _back_row(CREATE_BACK_FROM_DAYS),
    ]


def limit_buttons():
    return [
        [
            Button.inline("1", data="discount_limit_1"),
            Button.inline("2", data="discount_limit_2"),
            Button.inline("3", data="discount_limit_3"),
            Button.inline("5", data="discount_limit_5"),
        ],
        [
            Button.inline("10", data="discount_limit_10"),
            Button.inline("15", data="discount_limit_15"),
            Button.inline("25", data="discount_limit_25"),
        ],
        [
            Button.inline("50", data="discount_limit_50"),
            Button.inline("100", data="discount_limit_100"),
            Button.inline("200", data="discount_limit_200"),
        ],
        [Button.inline("500", data="discount_limit_500"), Button.inline("1000", data="discount_limit_1000")],
        [Button.inline("🎯 دلخواه", data="discount_limit_custom")],
        _back_row(CREATE_BACK_DAYS),
    ]


def percent_buttons():
    return [
        [
            Button.inline("5%", data="discount_percent_5"),
            Button.inline("10%", data="discount_percent_10"),
            Button.inline("15%", data="discount_percent_15"),
        ],
        [
            Button.inline("20%", data="discount_percent_20"),
            Button.inline("25%", data="discount_percent_25"),
            Button.inline("30%", data="discount_percent_30"),
        ],
        [
            Button.inline("40%", data="discount_percent_40"),
            Button.inline("50%", data="discount_percent_50"),
            Button.inline("75%", data="discount_percent_75"),
        ],
        [Button.inline("100%", data="discount_percent_100")],
        [Button.inline("🎯 دلخواه", data="discount_percent_custom")],
        _back_row(CREATE_BACK_LIMIT),
    ]


def edit_percent_buttons():
    return [
        [
            Button.inline("10%", data="edit_discount_percent_10"),
            Button.inline("20%", data="edit_discount_percent_20"),
            Button.inline("30%", data="edit_discount_percent_30"),
        ],
        [
            Button.inline("40%", data="edit_discount_percent_40"),
            Button.inline("50%", data="edit_discount_percent_50"),
        ],
        [Button.inline("🎯 دلخواه", data="edit_discount_percent_custom")],
        _back_row("discount_info_back"),
    ]


def edit_limit_buttons():
    return [
        [
            Button.inline("1", data="edit_discount_limit_1"),
            Button.inline("5", data="edit_discount_limit_5"),
            Button.inline("10", data="edit_discount_limit_10"),
        ],
        [
            Button.inline("25", data="edit_discount_limit_25"),
            Button.inline("50", data="edit_discount_limit_50"),
            Button.inline("100", data="edit_discount_limit_100"),
        ],
        [Button.inline("🎯 دلخواه", data="edit_discount_limit_custom")],
        _back_row("discount_info_back"),
    ]


def extend_buttons(code: str):
    return [
        [
            Button.inline("1 ساعت", data=f"ExtendDiscSec:{code}:3600"),
            Button.inline("6 ساعت", data=f"ExtendDiscSec:{code}:21600"),
            Button.inline("24 ساعت", data=f"ExtendDiscSec:{code}:86400"),
        ],
        [
            Button.inline("1 روز", data=f"ExtendDiscSec:{code}:86400"),
            Button.inline("7 روز", data=f"ExtendDiscSec:{code}:604800"),
            Button.inline("30 روز", data=f"ExtendDiscSec:{code}:2592000"),
        ],
        [Button.inline("🎯 تمدید دلخواه", data=f"ExtendDiscountCustom:{code}")],
        _back_row("discount_info_back"),
    ]


def discount_info_buttons(code: str, *, is_public: bool = True):
    return [
        [
            Button.inline("✏️ تغییر کد", data=f"EditDiscCode:{code}"),
            Button.inline("💸 تغییر درصد", data=f"EditDiscPercent:{code}"),
        ],
        [
            Button.inline("🔢 سقف استفاده", data=f"EditDiscLimit:{code}"),
            Button.inline("♻️ ریست استفاده", data=f"ResetDiscUsage:{code}"),
        ],
        [
            Button.inline("🌍 عمومی", data=f"SetDiscPublic:{code}"),
            Button.inline("💎 پرایوت", data=f"SetDiscPrivate:{code}"),
        ],
        [Button.inline("👤 تغییر کاربر", data=f"EditDiscUser:{code}")],
        [Button.inline("⏳ تمدید اعتبار", data=f"ExtendDiscountMenu:{code}")],
        [Button.inline("🗑 حذف کدتخفیف", data=f"DeleteDiscount:{code}")],
        [Button.inline("🔙 بازگشت به لیست", data=BACK_TO_DISCOUNT_LIST)],
    ]
