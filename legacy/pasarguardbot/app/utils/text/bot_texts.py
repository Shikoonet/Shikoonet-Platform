from telethon.tl.types import InputMediaWebPage

from app.db.crud.bot_texts import BotTextCRUD
from app.logger import get_logger

logger = get_logger(__name__)


async def get_bot_text(key: str, default: str, lang: str | None = None) -> str:
    text = await BotTextCRUD().get_text(key=key, lang=lang)
    return text if text is not None else default


async def get_bot_text_with_banner(
    key: str, default: str, lang: str | None = None
) -> tuple[str, InputMediaWebPage | None]:
    """
    Get bot text and banner file parameter if configured.
    Returns (text, file_param) where file_param is InputMediaWebPage or None.

    Usage example (like info_bot.py):
        text, banner_file = await get_bot_text_with_banner("start_message", "default text", lang="fa")
        await Kenzo.send_message(
            entity=user_id,
            message=text,
            file=banner_file,
            buttons=buttons,
        )
    """
    bot_text_obj = await BotTextCRUD().get_bot_text(key=key, lang=lang)

    if bot_text_obj:
        text = bot_text_obj.value
        banner_url = bot_text_obj.banner_url
    else:
        text = default
        banner_url = None

    file_param = None
    if banner_url:
        file_param = InputMediaWebPage(url=banner_url)
    logger.info(file_param)
    return text, file_param
