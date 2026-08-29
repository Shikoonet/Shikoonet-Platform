"""Keyboard builders for user games."""

from telethon.tl.custom import Button


def balance_button(amount: int):
    return [Button.inline(text=f"💳 موجودی جدید شما: {amount:,} تومان", data="no_action")]


def current_balance_button(amount: int):
    return [
        Button.inline(
            text=f"💳 موجودی فعلی کاربر: {amount:,} تومان",
            data="no_action",
        )
    ]


def new_user_balance_button(amount: int):
    return [Button.inline(text=f"💳 موجودی جدید کاربر: {amount:,} تومان", data="no_action")]


def new_balance_button(amount: int):
    return [Button.inline(text=f"💳 موجودی جدید: {amount:,} تومان", data="no_action")]


def back_to_games_button():
    return [Button.inline(text="🔙 بازگشت به منو", data="back_to_games")]


def rps_buttons():
    return [
        [Button.inline("🪨 سنگ", "rps_rock"), Button.inline("📄 کاغذ", "rps_paper")],
        [Button.inline("✂️ قیچی", "rps_scissors")],
    ]


def games_menu_buttons():
    return [
        [Button.inline("🎲 تاس", "game_dice"), Button.inline("🎯 دارت", "game_darts")],
        [Button.inline("🏀 بسکتبال", "game_basketball"), Button.inline("⚽ فوتبال", "game_football")],
        [Button.inline("✂️ سنگ کاغذ قیچی", "game_rps"), Button.inline("🎳 بولینگ", "game_bowling")],
    ]
