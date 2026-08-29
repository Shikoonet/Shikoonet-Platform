"""Callback handlers for user games."""

from telethon import events

from app import Kenzo
from app.db.crud.user import UserCRUD
from app.telegram.shared.utils.maintenance import bot_is_offline
from app.telegram.shared.utils.rate_limit import debounce_callback
from app.telegram.user.games.manager import GamesManager


@bot_is_offline
@debounce_callback()
async def back_to_games_handler(event):
    """Handle back to games callback"""
    message, buttons = await GamesManager(Kenzo).get_games_menu()
    await event.edit(message, buttons=buttons)


@bot_is_offline
@debounce_callback()
async def game_callback_handler(event):
    """Handle game callback queries"""
    data = event.data.decode("UTF-8")
    game_type = data.split("_")[1]

    games_manager = GamesManager(Kenzo)
    user_crud = UserCRUD()
    can_play = await user_crud.read_user(event.sender_id)
    last_game_play = can_play.last_dice_roll if can_play.last_dice_roll is not None else 0

    can_play_game, cooldown_message = await games_manager.check_game_cooldown(event.sender_id, last_game_play)
    if not can_play_game:
        await event.edit(
            f"<blockquote expandable>{cooldown_message}</blockquote>",
            parse_mode="html",
        )
    else:
        if game_type == "dice":
            await games_manager.play_dice_game(event, event.sender_id)
        elif game_type == "darts":
            await games_manager.play_darts_game(event, event.sender_id)
        elif game_type == "basketball":
            await games_manager.play_basketball_game(event, event.sender_id)
        elif game_type == "football":
            await games_manager.play_football_game(event, event.sender_id)
        elif game_type == "slot":
            await games_manager.play_slot_game(event, event.sender_id)
        elif game_type == "bowling":
            await games_manager.play_bowling_game(event, event.sender_id)
        elif game_type == "rps":
            await games_manager.play_rps_game(event, event.sender_id)


@bot_is_offline
@debounce_callback()
async def rps_callback_handler(event):
    """Handle Rock Paper Scissors callback queries"""
    data = event.data.decode("UTF-8")
    choice = data.split("_")[1]

    games_manager = GamesManager(Kenzo)
    await games_manager.handle_rps_choice(event, choice, event.sender_id)


def register(client):
    client.add_event_handler(back_to_games_handler, events.CallbackQuery(data="back_to_games"))
    client.add_event_handler(game_callback_handler, events.CallbackQuery(pattern=rb"game_.*"))
    client.add_event_handler(rps_callback_handler, events.CallbackQuery(pattern=rb"rps_.*"))
