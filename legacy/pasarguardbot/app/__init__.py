from telethon import TelegramClient
from telethon.extensions import markdown
from telethon.extensions.markdown import DEFAULT_DELIMITERS
from telethon.tl.types import (
    MessageEntityBlockquote,
    MessageEntityCustomEmoji,
    MessageEntitySpoiler,
    MessageEntityTextUrl,
)

from config import API_HASH, API_ID, BOT_TOKEN, TELETHON_SESSION_PATH

if not API_ID or not API_HASH or not BOT_TOKEN:
    raise ValueError("API_ID, API_HASH, and BOT_TOKEN are required!")


DEFAULT_DELIMITERS["^q^"] = lambda *a, **k: MessageEntityBlockquote(*a, **k, collapsed=False)
DEFAULT_DELIMITERS["^qc^"] = lambda *a, **k: MessageEntityBlockquote(*a, **k, collapsed=True)
DEFAULT_DELIMITERS["^sp^"] = lambda *a, **k: MessageEntitySpoiler(*a, **k)


class CustomMarkdown:
    """Custom Markdown parser to support premium emoji in the format [emoji](emoji/document_id)"""

    @staticmethod
    def parse(text):
        text, entities = markdown.parse(text)
        for i, e in enumerate(entities):
            if isinstance(e, MessageEntityTextUrl):
                if e.url == "spoiler":
                    entities[i] = MessageEntitySpoiler(e.offset, e.length)
                elif e.url.startswith("emoji/"):
                    entities[i] = MessageEntityCustomEmoji(e.offset, e.length, int(e.url.split("/")[1]))
                elif e.url.startswith("tg://emoji?id="):
                    doc_id = int(e.url.split("id=")[1].split("&")[0])
                    entities[i] = MessageEntityCustomEmoji(e.offset, e.length, doc_id)
        return text, entities

    @staticmethod
    def unparse(text, entities):
        for i, e in enumerate(entities or []):
            if isinstance(e, MessageEntityCustomEmoji):
                entities[i] = MessageEntityTextUrl(e.offset, e.length, f"emoji/{e.document_id}")
            if isinstance(e, MessageEntitySpoiler):
                entities[i] = MessageEntityTextUrl(e.offset, e.length, "spoiler")
        return markdown.unparse(text, entities)


Kenzo = TelegramClient(TELETHON_SESSION_PATH, API_ID, API_HASH)
Kenzo.parse_mode = CustomMarkdown()
