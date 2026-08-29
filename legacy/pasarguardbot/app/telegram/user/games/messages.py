"""Message handlers for user games."""

from telethon import events

from app import Kenzo
from app.db.crud.user import UserCRUD
from app.telegram.shared.utils.maintenance import bot_is_offline
from app.telegram.user.games.manager import GamesManager


def game_message_text(event) -> str:
    return event.message.text or event.message.message or ""


async def dice_shortcut_filter(event):
    if event.is_channel:
        return False
    return game_message_text(event) == "/dice"


async def word_guess_filter(event):
    if event.is_channel:
        return False

    msg = game_message_text(event)
    if not msg or msg.isdigit() or msg.startswith("/"):
        return False

    user = await UserCRUD().read_user(event.sender_id)
    return bool(user and user.current_game_data)


@bot_is_offline
async def dice_shortcut_handler(event):
    """Handle legacy /dice shortcut messages."""
    await GamesManager(Kenzo).play_dice_shortcut(event, event.sender_id)
    raise events.StopPropagation


@bot_is_offline
async def word_guess_message_handler(event):
    """Handle word guessing game input."""
    user = await UserCRUD().read_user(event.sender_id)
    if not user or not user.current_game_data:
        return

    await GamesManager(Kenzo).handle_word_guess(
        event,
        event.sender_id,
        game_message_text(event).strip(),
        user.current_game_data,
    )
    raise events.StopPropagation


@bot_is_offline
async def games_command_handler(event):
    """Handle /games command"""
    message, buttons = await GamesManager(Kenzo).get_games_menu()
    await event.reply(message, buttons=buttons)
    raise events.StopPropagation


def register(client):
    client.add_event_handler(
        dice_shortcut_handler,
        events.NewMessage(incoming=True, func=dice_shortcut_filter),
    )
    client.add_event_handler(
        word_guess_message_handler,
        events.NewMessage(incoming=True, func=word_guess_filter),
    )
    client.add_event_handler(games_command_handler, events.NewMessage(pattern="/games"))
