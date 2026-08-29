"""Text templates for user games."""

REWARDS = [500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 10000]
DICE_SHORTCUT_REWARDS = [1000, 1500, 2000, 3000]

WORD_GUESS_PRIZES = [3000, 4000, 5000]

RPS_CHOICE_EMOJIS = {"rock": "🪨", "paper": "📄", "scissors": "✂️"}
RPS_CHOICE_NAMES = {"rock": "سنگ", "paper": "کاغذ", "scissors": "قیچی"}
RPS_TIE_PRIZE = 200

GAMES_MENU_MESSAGE = (
    "🎮 **منوی بازی‌های جذاب** 🎮\n\n"
    "🎲 تاس - شانس برنده شدن با عدد 6\n"
    "🎯 دارت - امتیاز بالا برای برنده شدن\n"
    "🏀 بسکتبال - شوت موفق برای برنده شدن\n"
    "⚽ فوتبال - گل زدن برای برنده شدن\n"
    "🎳 بولینگ - استرایک برای برنده شدن\n"
    "✂️ سنگ کاغذ قیچی - رقابت با ربات\n"
    "💡 هر بازی روزی یکبار قابل انجام است!"
)

RPS_MENU_MESSAGE = "✂️ **بازی سنگ کاغذ قیچی** ✂️\n\nانتخاب کنید:"


def game_cooldown_message(remaining_time: list[str]) -> str:
    return f"🎮 شما بعد از {','.join(remaining_time)} دیگر مجدد میتونید بازی کنید"


def dice_shortcut_cooldown_message(remaining_time: list[str]) -> str:
    return f"<blockquote expandable>👻 شما بعد از {','.join(remaining_time)} دیگر مجدد میتونید تاس بندازید</blockquote>"


def dice_shortcut_win_message(prize: int) -> str:
    return f"🎉 تبریک می‌گم! شانس با شما یار بود و با آوردن عدد 6 مبلغ {prize:,} تومان به حساب شما اضافه شد! 💰"


def dice_shortcut_win_log_message(user_id: int, prize: int) -> str:
    return f"🎲 کاربر خوش‌شانس {user_id} با انداختن تاس، عدد 6 آورد و برنده مبلغ {prize:,} تومان شد! 🎉"


def dice_shortcut_lose_message(dice_value: int) -> str:
    return f"🎲 تاس شما روی عدد {dice_value} ایستاد! متأسفانه برنده نشدید. 😥 شانس خود را فردا دوباره امتحان کنید! 🍀"


def dice_shortcut_lose_log_message(user_id: int, dice_value: int) -> str:
    return f"🎲 کاربر {user_id} با انداختن تاس، عدد {dice_value} را آورد. متأسفانه برنده نشد. 😥"


def word_guess_win_message(target_word: str, prize: int) -> str:
    return (
        f"🎉 **تبریک!** 🎉\n\n"
        f"شما کلمه '{target_word}' را درست حدس زدید!\n"
        f"💰 مبلغ {prize:,} تومان به حساب شما اضافه شد!\n\n"
        f"🧠 **کلمات سخت‌تر = جوایز بیشتر!**"
    )


def word_guess_win_log_message(user_id: int, target_word: str, prize: int) -> str:
    return f"📝 کاربر خوش‌شانس {user_id} در بازی حدس کلمه، کلمه سخت '{target_word}' را درست حدس زد و {prize:,} تومان جایزه گرفت! 🎉"


def word_guess_lose_message(target_word: str) -> str:
    return (
        f"❌ **متأسفانه اشتباه بود!**\n\n"
        f"کلمه صحیح: **{target_word}**\n\n"
        f"💡 **نکته:** کلمات سخت‌تر نیاز به دقت بیشتری دارند!\n"
        f"🍀 شانس خود را فردا دوباره امتحان کنید!"
    )


def dice_game_win_message(prize: int) -> str:
    return f"🎉 تبریک می‌گم! شانس با شما یار بود و با آوردن عدد 6 مبلغ {prize:,} تومان به حساب شما اضافه شد! 💰"


def dice_game_win_log_message(user_id: int, prize: int) -> str:
    return f"🎲 کاربر خوش‌شانس {user_id} با انداختن تاس، عدد 6 آورد و برنده مبلغ {prize:,} تومان شد! 🎉"


def dice_game_lose_message(dice_value: int) -> str:
    return f"🎲 تاس شما روی عدد {dice_value} ایستاد! متأسفانه برنده نشدید. 😥 شانس خود را فردا دوباره امتحان کنید! 🍀"


def darts_game_win_message(darts_value: int, prize: int) -> str:
    return f"🎉 تبریک می‌گم! شانس با شما یار بود و با امتیاز {darts_value} مبلغ {prize:,} تومان به حساب شما اضافه شد! 💰"


def darts_game_win_log_message(user_id: int, darts_value: int, prize: int) -> str:
    return f"🎯 کاربر خوش‌شانس {user_id} با دارت، امتیاز {darts_value} آورد و برنده مبلغ {prize:,} تومان شد! 🎉"


def darts_game_lose_message(darts_value: int) -> str:
    return (
        f"🎯 دارت شما روی امتیاز {darts_value} ایستاد! متأسفانه برنده نشدید. 😥 شانس خود را فردا دوباره امتحان کنید! 🍀"
    )


def basketball_game_win_message(prize: int) -> str:
    return f"🎉 تبریک می‌گم! شانس با شما یار بود و با شوت موفق مبلغ {prize:,} تومان به حساب شما اضافه شد! 💰"


def basketball_game_win_log_message(user_id: int, prize: int) -> str:
    return f"🏀 کاربر خوش‌شانس {user_id} با بسکتبال، شوت موفق زد و برنده مبلغ {prize:,} تومان شد! 🎉"


BASKETBALL_GAME_LOSE_MESSAGE = "🏀 شوت شما موفق نبود! متأسفانه برنده نشدید. 😥 شانس خود را فردا دوباره امتحان کنید! 🍀"


def football_game_win_message(prize: int) -> str:
    return f"🎉 تبریک می‌گم! شانس با شما یار بود و با گل زدن مبلغ {prize:,} تومان به حساب شما اضافه شد! 💰"


def football_game_win_log_message(user_id: int, prize: int) -> str:
    return f"⚽ کاربر خوش‌شانس {user_id} با فوتبال، گل زد و برنده مبلغ {prize:,} تومان شد! 🎉"


FOOTBALL_GAME_LOSE_MESSAGE = "⚽ گل شما موفق نبود! متأسفانه برنده نشدید. 😥 شانس خود را فردا دوباره امتحان کنید! 🍀"


def slot_game_win_message(prize: int) -> str:
    return f"🎉 تبریک می‌گم! شانس با شما یار بود و با ترکیب موفق مبلغ {prize:,} تومان به حساب شما اضافه شد! 💰"


def slot_game_win_log_message(user_id: int, prize: int) -> str:
    return f"🎰 کاربر خوش‌شانس {user_id} با ماشین اسلات، ترکیب موفق کرد و برنده مبلغ {prize:,} تومان شد! 🎉"


SLOT_GAME_LOSE_MESSAGE = "🎰 ترکیب شما موفق نبود! متأسفانه برنده نشدید. 😥 شانس خود را فردا دوباره امتحان کنید! 🍀"


def bowling_game_win_message(prize: int) -> str:
    return f"🎉 تبریک می‌گم! شانس با شما یار بود و با استرایک مبلغ {prize:,} تومان به حساب شما اضافه شد! 💰"


def bowling_game_win_log_message(user_id: int, prize: int) -> str:
    return f"🎳 کاربر خوش‌شانس {user_id} با بولینگ، استرایک کرد و برنده مبلغ {prize:,} تومان شد! 🎉"


BOWLING_GAME_LOSE_MESSAGE = "🎳 استرایک شما موفق نبود! متأسفانه برنده نشدید. 😥 شانس خود را فردا دوباره امتحان کنید! 🍀"


def rps_result_message(
    user_emoji: str,
    user_name: str,
    bot_emoji: str,
    bot_name: str,
    outcome: str,
    prize: int,
) -> str:
    header = "✂️ **بازی سنگ کاغذ قیچی** ✂️\n\n"
    body = f"شما: {user_emoji} {user_name}\nربات: {bot_emoji} {bot_name}\n\n"
    if outcome == "tie":
        return header + body + f"🤝 مساوی! جایزه تسلی {prize:,} تومان!"
    if outcome == "win":
        return header + body + f"🎉 تبریک! شما برنده شدید و {prize:,} تومان جایزه گرفتید!"
    return header + body + "😔 متأسفانه این بار برنده نشدید! شانس خود را فردا دوباره امتحان کنید! 🍀"


def rps_win_log_message(user_id: int, prize: int) -> str:
    return f"✂️ کاربر {user_id} در سنگ کاغذ قیچی {prize:,} تومان برنده شد! 🎉"
