"""Payment bonus calculation (no app.db / telethon imports)."""


async def calculate_payment_bonus(amount: int, bonus_enabled: bool, bonus_percent: int) -> int:
    if not bonus_enabled or bonus_percent <= 0:
        return 0
    return int(amount * bonus_percent / 100)
