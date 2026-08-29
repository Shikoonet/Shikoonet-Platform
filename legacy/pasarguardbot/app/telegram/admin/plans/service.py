"""Shared helpers for admin plans."""

from telethon import Button

from app import Kenzo
from app.db.crud.plans import PlanManager
from app.logger import get_logger
from app.telegram.admin.plans import texts
from app.telegram.shared.keyboards.plan_buttons import (
    build_plan_admin_list_button,
    plan_has_display_override,
)

logger = get_logger(__name__)

to_persian_digits = texts.to_persian_digits
format_number = texts.format_number


def is_number(msg):
    try:
        float(msg)
        return True
    except ValueError:
        return False


async def display_plan_info(
    plan_id,
    user_id,
    panel_code,
    edit_message=False,
    original_event=None,
    extra_message=None,
    show_edit_buttons=True,
    message_id=None,
    current_page=1,
):
    """English docstring for display_plan_info."""
    plan = await PlanManager().get_plan(plan_id)
    if not plan:
        if original_event:
            await original_event.answer("پلن یافت نشد!", alert=True)
        else:
            await Kenzo.send_message(entity=user_id, message="پلن یافت نشد!")
        return None

    if panel_code is None:
        panel_code = plan.panel_code

    plan_type_text = {
        "volume": "📊 حجمی",
        "unlimited_volume": "♾️ نامحدود حجمی",
        "fair_usage": "⚖️ مصرف منصفانه",
    }.get(plan.plan_type, "📊 حجمی")

    reset_text = {
        "no_reset": "بدون ریست",
        "day": "روزانه",
        "week": "هفتگی",
        "month": "ماهانه",
        "year": "سالانه",
    }.get(plan.data_limit_reset_strategy, "بدون ریست")

    ip_limit_text = "♾️ نامحدود" if plan.ip_limit == 0 else f"👥 {plan.ip_limit} کاربر"
    display_status = "✅ سفارشی" if plan_has_display_override(plan) else "📋 پیش‌فرض (کلاسیک)"

    message = (
        f"📋 **اطلاعات پلن**\n\n"
        f"💾 **حجم:** {plan.storage} گیگابایت\n"
        f"💰 **قیمت:** {int(plan.price):,} تومان\n"
        f"⏰ **مدت زمان:** {plan.duration} روز\n"
        f"📊 **نوع پلن:** {plan_type_text}\n"
        f"🔄 **ریست حجم:** {reset_text}\n"
        f"🔌 **محدودیت کاربر:** {ip_limit_text}\n"
        f"🎨 **دکمه نمایش:** {display_status}"
    )

    if extra_message:
        message += f"\n\n{extra_message}"

    buttons = []
    if show_edit_buttons:
        panel_code_str = str(panel_code) if panel_code is not None else str(plan.panel_code)
        buttons = [
            [
                Button.inline("✏️ ویرایش قیمت", data=f"edit_price:{plan_id}"),
                Button.inline("✏️ ویرایش حجم", data=f"edit_storage:{plan_id}"),
            ],
            [
                Button.inline("✏️ ویرایش زمان", data=f"edit_duration:{plan_id}"),
                Button.inline("✏️ ویرایش محدودیت کاربر", data=f"edit_ip_limit:{plan_id}"),
            ],
            [Button.inline("🎨 تنظیم دکمه نمایش", data=f"edit_plan_display:{plan_id}:{current_page}")],
            [Button.inline("🗑 حذف پلن", data=f"delete_plan:{plan_id}")],
            [Button.inline("🔙 بازگشت", data=f"BackToPlanList:{panel_code_str}:{current_page}")],
        ]
    else:
        buttons = [
            [Button.inline("🔙 بازگشت", data=f"plan_info:{plan_id}")],
        ]

    if edit_message and original_event:
        await Kenzo.edit_message(
            entity=original_event.original_update.user_id,
            message=original_event.original_update.msg_id,
            text=message,
            buttons=buttons,
        )
    elif message_id:
        await Kenzo.edit_message(
            entity=user_id,
            message=message_id,
            text=message,
            buttons=buttons,
        )
    else:
        sent_message = await Kenzo.send_message(entity=user_id, message=message, buttons=buttons)
        return sent_message.id
    return None


async def display_plans(user_id, panel_code, current_page=1, edit_message=False, original_event=None):
    plans = await PlanManager().get_all_plans(panel_code=panel_code)
    plans = sorted(plans, key=lambda p: p.storage)
    PANEL_LIMIT = 20

    if not plans:
        await Kenzo.send_message(entity=user_id, message="هیچ پلنی موجود نیست.")
        return

    total_plans = len(plans)
    num_pages = (total_plans + PANEL_LIMIT - 1) // PANEL_LIMIT
    start_index = (current_page - 1) * PANEL_LIMIT
    end_index = start_index + PANEL_LIMIT

    current_plans = plans[start_index:end_index]

    plan_buttons = []
    for plan in current_plans:
        plan_buttons.append(
            [
                await build_plan_admin_list_button(
                    plan,
                    f"plan_info:{plan.id}:{current_page}",
                    persian_digits=to_persian_digits,
                )
            ]
        )
    navigation_buttons = []
    if current_page > 1:
        navigation_buttons.append(Button.inline("صفحه قبلی ->", data=f"PrevPlan:{panel_code}:{current_page}"))
    if current_page < num_pages:
        navigation_buttons.append(Button.inline("<- صفحه بعدی", data=f"NextPlan:{panel_code}:{current_page}"))

    plan_buttons.append(navigation_buttons)
    plan_buttons.append([Button.inline("🔙 بازگشت", data="PlanManageSelectPanel")])

    message_text = f"📋 لیست پلن ها ({total_plans})"

    if edit_message and original_event:
        await Kenzo.edit_message(
            entity=original_event.original_update.user_id,
            message=original_event.original_update.msg_id,
            text=message_text,
            buttons=plan_buttons,
        )
    else:
        await Kenzo.send_message(entity=user_id, message=message_text, buttons=plan_buttons)
