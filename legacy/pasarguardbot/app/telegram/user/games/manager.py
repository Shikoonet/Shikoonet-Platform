"""Game logic for user games."""

import random
from datetime import datetime, timedelta

from telethon.tl.functions.messages import SendMediaRequest
from telethon.tl.types import InputMediaDice

from app.db.crud.user import UserCRUD, update_Money
from app.logger import LogType, get_logger
from app.telegram.shared.utils.logging import send_log_message
from app.telegram.user.games import keyboards, texts

logger = get_logger(__name__)


class GamesManager:
    """Manages all game-related functionality"""

    def __init__(self, bot):
        self.bot = bot

    async def check_game_cooldown(self, user_id, last_play_timestamp):
        """Check if user can play games (once per day)"""
        if last_play_timestamp is None:
            return True, None

        input_time = datetime.fromtimestamp(last_play_timestamp)
        next_play = input_time + timedelta(days=1)
        current_time = datetime.now()
        time_difference = next_play - current_time

        if time_difference.total_seconds() > 0:
            days = time_difference.days
            hours, remainder = divmod(time_difference.seconds, 3600)
            minutes, seconds = divmod(remainder, 60)

            remaining_time = []
            if days > 0:
                remaining_time.append(f"{days} روز")
            if hours > 0:
                remaining_time.append(f"{hours} ساعت")
            if minutes > 0:
                remaining_time.append(f"{minutes} دقیقه")
            if seconds > 0:
                remaining_time.append(f"{seconds} ثانیه")

            return False, texts.game_cooldown_message(remaining_time)

        return True, None

    async def play_dice_shortcut(self, event, user_id):
        """Play the legacy /dice shortcut from a user message."""
        user_crud = UserCRUD()
        can_roll = await user_crud.read_user(user_id)
        last_dice_roll = can_roll.last_dice_roll if can_roll and can_roll.last_dice_roll is not None else 0

        input_time = datetime.fromtimestamp(last_dice_roll)
        next_day = input_time + timedelta(days=1)
        current_time = datetime.now()
        time_difference = next_day - current_time
        if time_difference.total_seconds() > 0:
            days = time_difference.days
            hours, remainder = divmod(time_difference.seconds, 3600)
            minutes, seconds = divmod(remainder, 60)

            remaining_time = []
            if days > 0:
                remaining_time.append(f"{days} روز")
            if hours > 0:
                remaining_time.append(f"{hours} ساعت")
            if minutes > 0:
                remaining_time.append(f"{minutes} دقیقه")
            if seconds > 0:
                remaining_time.append(f"{seconds} ثانیه")
            await event.reply(
                texts.dice_shortcut_cooldown_message(remaining_time),
                parse_mode="html",
            )
            return

        updates = await self.bot(SendMediaRequest(peer=user_id, media=InputMediaDice(emoticon="🎲"), message=""))
        dice_value = updates.updates[1].message.media.value
        await UserCRUD().update_user(user_id=user_id, last_dice_roll=datetime.now().timestamp())

        if dice_value == 6:
            prize = random.choice(texts.DICE_SHORTCUT_REWARDS)
            new_amount = await update_Money(user_id=user_id, Money=int(prize))
            await event.reply(
                texts.dice_shortcut_win_message(prize),
                buttons=keyboards.balance_button(new_amount),
            )
            await send_log_message(
                LogType.OTHER,
                message=texts.dice_shortcut_win_log_message(user_id, prize),
                buttons=keyboards.new_user_balance_button(new_amount),
            )
            return

        await event.reply(texts.dice_shortcut_lose_message(dice_value))
        await send_log_message(
            LogType.OTHER,
            message=texts.dice_shortcut_lose_log_message(user_id, dice_value),
            buttons=keyboards.current_balance_button(getattr(can_roll, "amount", 0)),
        )

    async def handle_word_guess(self, event, user_id, guess_word, target_word):
        """Handle one-shot word guessing game input."""
        if guess_word == target_word:
            prize = random.choice(texts.WORD_GUESS_PRIZES)
            new_amount = await update_Money(user_id=user_id, Money=prize)

            await event.reply(
                texts.word_guess_win_message(target_word, prize),
                buttons=keyboards.new_balance_button(new_amount),
            )
            await send_log_message(
                LogType.OTHER,
                message=texts.word_guess_win_log_message(user_id, target_word, prize),
            )
            await UserCRUD().update_user(user_id=user_id, current_game_data=None)
            return

        await event.reply(
            texts.word_guess_lose_message(target_word),
            buttons=keyboards.back_to_games_button(),
        )
        await UserCRUD().update_user(user_id=user_id, current_game_data=None)

    async def play_dice_game(self, event, user_id):
        """Play dice game using Telegram dice API"""
        updates = await self.bot(SendMediaRequest(peer=user_id, media=InputMediaDice(emoticon="🎲"), message=""))
        dice_value = updates.updates[1].message.media.value
        logger.info("Dice :%s", dice_value)
        await UserCRUD().update_user(user_id=user_id, last_dice_roll=datetime.now().timestamp())

        if dice_value == 6:
            prize = random.choice(texts.REWARDS)
            new_amount = await update_Money(user_id=user_id, Money=int(prize))

            await event.edit(
                texts.dice_game_win_message(prize),
                buttons=keyboards.balance_button(new_amount),
            )

            await send_log_message(
                LogType.OTHER,
                message=texts.dice_game_win_log_message(user_id, prize),
            )
        else:
            await event.edit(texts.dice_game_lose_message(dice_value))

    async def play_darts_game(self, event, user_id):
        """Play darts game using Telegram darts API"""
        updates = await self.bot(SendMediaRequest(peer=user_id, media=InputMediaDice(emoticon="🎯"), message=""))
        darts_value = updates.updates[1].message.media.value
        logger.info("Dart :%s", darts_value)
        await UserCRUD().update_user(user_id=user_id, last_dice_roll=datetime.now().timestamp())

        if darts_value >= 6:
            prize = random.choice(texts.REWARDS)
            new_amount = await update_Money(user_id=user_id, Money=int(prize))

            await event.edit(
                texts.darts_game_win_message(darts_value, prize),
                buttons=keyboards.balance_button(new_amount),
            )

            await send_log_message(
                LogType.OTHER,
                message=texts.darts_game_win_log_message(user_id, darts_value, prize),
            )
        else:
            await event.edit(texts.darts_game_lose_message(darts_value))

    async def play_basketball_game(self, event, user_id):
        """Play basketball game using Telegram basketball API"""
        updates = await self.bot(SendMediaRequest(peer=user_id, media=InputMediaDice(emoticon="🏀"), message=""))
        basketball_value = updates.updates[1].message.media.value
        logger.info("basketball :%s", basketball_value)
        await UserCRUD().update_user(user_id=user_id, last_dice_roll=datetime.now().timestamp())

        if basketball_value >= 4:
            prize = random.choice(texts.REWARDS)
            new_amount = await update_Money(user_id=user_id, Money=int(prize))

            await event.edit(
                texts.basketball_game_win_message(prize),
                buttons=keyboards.balance_button(new_amount),
            )

            await send_log_message(
                LogType.OTHER,
                message=texts.basketball_game_win_log_message(user_id, prize),
            )
        else:
            await event.edit(texts.BASKETBALL_GAME_LOSE_MESSAGE)

    async def play_football_game(self, event, user_id):
        """Play football game using Telegram football API"""
        updates = await self.bot(SendMediaRequest(peer=user_id, media=InputMediaDice(emoticon="⚽"), message=""))
        football_value = updates.updates[1].message.media.value
        logger.info("football :%s", football_value)
        await UserCRUD().update_user(user_id=user_id, last_dice_roll=datetime.now().timestamp())

        if football_value >= 6:
            prize = random.choice(texts.REWARDS)
            new_amount = await update_Money(user_id=user_id, Money=int(prize))

            await event.edit(
                texts.football_game_win_message(prize),
                buttons=keyboards.balance_button(new_amount),
            )

            await send_log_message(
                LogType.OTHER,
                message=texts.football_game_win_log_message(user_id, prize),
            )
        else:
            await event.edit(texts.FOOTBALL_GAME_LOSE_MESSAGE)

    async def play_slot_game(self, event, user_id):
        """Play slot machine game using Telegram slot API"""
        updates = await self.bot(SendMediaRequest(peer=user_id, media=InputMediaDice(emoticon="🎰"), message=""))
        slot_value = updates.updates[1].message.media.value
        logger.info("slot :%s", slot_value)
        await UserCRUD().update_user(user_id=user_id, last_dice_roll=datetime.now().timestamp())

        if slot_value >= 6:
            prize = random.choice(texts.REWARDS)
            new_amount = await update_Money(user_id=user_id, Money=int(prize))

            await event.edit(
                texts.slot_game_win_message(prize),
                buttons=keyboards.balance_button(new_amount),
            )
            await send_log_message(
                LogType.OTHER,
                message=texts.slot_game_win_log_message(user_id, prize),
            )

        else:
            await event.edit(texts.SLOT_GAME_LOSE_MESSAGE)

    async def play_bowling_game(self, event, user_id):
        """Play bowling game using Telegram bowling API"""
        updates = await self.bot(SendMediaRequest(peer=user_id, media=InputMediaDice(emoticon="🎳"), message=""))
        bowling_value = updates.updates[1].message.media.value
        logger.info("bowling :%s", bowling_value)
        await UserCRUD().update_user(user_id=user_id, last_dice_roll=datetime.now().timestamp())

        if bowling_value >= 6:
            prize = random.choice(texts.REWARDS)
            new_amount = await update_Money(user_id=user_id, Money=int(prize))

            await event.edit(
                texts.bowling_game_win_message(prize),
                buttons=keyboards.balance_button(new_amount),
            )
            await send_log_message(
                LogType.OTHER,
                message=texts.bowling_game_win_log_message(user_id, prize),
            )

        else:
            await event.edit(texts.BOWLING_GAME_LOSE_MESSAGE)

    async def play_rps_game(self, event, user_id):
        """Play Rock Paper Scissors game"""
        await UserCRUD().update_user(user_id=user_id, last_dice_roll=datetime.now().timestamp())

        await event.edit(
            texts.RPS_MENU_MESSAGE,
            buttons=keyboards.rps_buttons(),
        )

    async def handle_rps_choice(self, event, choice, user_id):
        """Handle Rock Paper Scissors choice"""
        await UserCRUD().update_user(user_id=user_id, last_dice_roll=datetime.now().timestamp())

        choices = ["rock", "paper", "scissors"]
        bot_choice = random.choice(choices)

        user_emoji = texts.RPS_CHOICE_EMOJIS[choice]
        bot_emoji = texts.RPS_CHOICE_EMOJIS[bot_choice]
        user_name = texts.RPS_CHOICE_NAMES[choice]
        bot_name = texts.RPS_CHOICE_NAMES[bot_choice]

        if choice == bot_choice:
            prize = texts.RPS_TIE_PRIZE
            message = texts.rps_result_message(user_emoji, user_name, bot_emoji, bot_name, "tie", prize)
        elif (
            (choice == "rock" and bot_choice == "scissors")
            or (choice == "paper" and bot_choice == "rock")
            or (choice == "scissors" and bot_choice == "paper")
        ):
            prize = random.choice(texts.REWARDS)
            message = texts.rps_result_message(user_emoji, user_name, bot_emoji, bot_name, "win", prize)
        else:
            prize = 0
            message = texts.rps_result_message(user_emoji, user_name, bot_emoji, bot_name, "lose", prize)

        if prize > 0:
            new_amount = await update_Money(user_id=user_id, Money=prize)
            await event.edit(
                message,
                buttons=keyboards.new_balance_button(new_amount),
            )
            await send_log_message(
                LogType.OTHER,
                message=texts.rps_win_log_message(user_id, prize),
            )

        else:
            await event.edit(message)

    async def get_games_menu(self):
        """Get the games menu message and buttons"""
        return texts.GAMES_MENU_MESSAGE, keyboards.games_menu_buttons()
