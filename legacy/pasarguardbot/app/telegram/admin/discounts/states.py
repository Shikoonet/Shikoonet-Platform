"""State constants for admin discount code management."""

DISCOUNT_PER_PAGE = 10

DISCOUNT_CREATION_KEYS = (
    "discount_is_public",
    "discount_user_id",
    "discount_days",
    "discount_expiration_seconds",
    "discount_limit",
    "discount_manual_code",
    "discount_percent",
)

DISCOUNT_ADMIN_STEPS = frozenset(
    {
        "takhfif_select",
        "discount_info_view",
        "discount_user",
        "discount_code_input",
        "discount_days_custom",
        "discount_limit_custom",
        "discount_percent_custom",
        "discount_edit_code",
        "discount_edit_user",
        "discount_edit_percent_custom",
        "discount_edit_limit_custom",
        "discount_extend_custom",
    }
)

DISCOUNT_INFO_STEPS = frozenset({"takhfif_select", "discount_info_view"})

DISCOUNT_MENU_MESSAGE = "🎟 کدتخفیف"
