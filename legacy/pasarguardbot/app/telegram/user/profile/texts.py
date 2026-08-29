"""Text templates for user profile."""

from app.utils.formatting.dates import Time_Date


def discount_code_text(discount_code) -> str:
    expiration = Time_Date(discount_code.expiration_date)
    usage_line = ""
    if not discount_code.is_public:
        usage_line = f"**🔢 تعداد استفاده:** `{discount_code.times_used}`**/**`{discount_code.usage_limit}`\n"
    return (
        "\n"
        f"**📌 کدتخفیف:** `{discount_code.code}`\n"
        f"**💸 درصد تخفیف:** `{discount_code.discount_percentage}%`\n"
        f"{usage_line}"
        f"**📋 نوع کد:** {'`🌍 عمومی 🌍`' if discount_code.is_public else '`💎 پرایوت 💎`'}\n"
        f"**⏳ تاریخ انقضا:** `{expiration['jf']} ({expiration['remaining_days']})`\n"
    )


def profile_message(
    user_id: int,
    info,
    date_label: str,
    discount_status: str,
) -> str:
    return (
        f"**👤 شناسه کاربری:** `{user_id}`\n"
        f"**👥 تعداد زیرمجموعه ها:**  `{info.invite:,}`\n"
        f"**💰 موجودی:** `{info.amount:,.0f}` تومان\n"
        f"**📞 شماره تلفن:** `{info.number}`\n"
        f"**🕒 تاریخ عضویت:** `{date_label}`\n"
        f"{discount_status}\n"
    )
