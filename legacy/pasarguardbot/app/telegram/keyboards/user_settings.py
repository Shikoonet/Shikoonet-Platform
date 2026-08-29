"""User-facing advanced settings buttons."""

from telethon import Button

from .settings import sts_txt


def create_buttons_user_settings(user):
    return [
        [Button.inline("¦¦—— تنظیمات سرویس ——¦¦", b"no_action")],
        [
            Button.inline(
                f"کلمه اکانت: {sts_txt(user.show_service_word)}",
                b"user_setting.show_service_word",
            ),
            Button.inline(
                f"نام کانفیگ: {sts_txt(user.show_config_name)}",
                b"user_setting.show_config_name",
            ),
        ],
        [
            Button.inline(
                f"حجم: {sts_txt(user.show_volume)}",
                b"user_setting.show_volume",
            ),
            Button.inline(
                f"نام پنل: {sts_txt(user.show_panel)}",
                b"user_setting.show_panel",
            ),
        ],
        [
            Button.inline(
                f"🔲 تعداد نمایش دکمه‌ها (افقی): {user.service_buttons_per_row}",
                b"user_setting.row_size_menu",
            )
        ],
        [
            Button.inline(
                f"🔳 تعداد نمایش دکمه ها (عمودی): {user.service_button_rows}",
                b"user_setting.row_count_menu",
            )
        ],
        [Button.inline("¦¦—— ابزارهای کاربردی ——¦¦", b"no_action")],
        [Button.inline("📦 تبدیل متن به QR Code", b"user_setting.qr_text")],
        [Button.inline("بازگشت", b"user_setting.back")],
    ]


def create_buttons_row_size(current: int) -> list:
    rows: list[list[Button]] = []
    first: list[Button] = []
    second: list[Button] = []
    for i in range(1, 9):
        text = f"{i}"
        if i == current:
            text = f"✅ {i}"
        btn = Button.inline(text, data=f"user_setting.row_size.{i}")
        if i <= 4:
            first.append(btn)
        else:
            second.append(btn)
    rows.append(first)
    rows.append(second)
    rows.append([Button.inline("بازگشت", b"user_setting.row_size.back")])
    return rows


def create_buttons_row_count(current: int) -> list:
    rows: list[list[Button]] = []
    temp: list[Button] = []
    for i in range(1, 21):
        text = f"{i}"
        if i == current:
            text = f"✅ {i}"
        btn = Button.inline(text, data=f"user_setting.row_count.{i}")
        temp.append(btn)
        if i % 5 == 0:
            rows.append(temp)
            temp = []
    if temp:
        rows.append(temp)
    rows.append([Button.inline("بازگشت", b"user_setting.row_count.back")])
    return rows
