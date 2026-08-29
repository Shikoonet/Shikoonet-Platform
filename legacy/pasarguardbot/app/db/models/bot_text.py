from sqlalchemy import BigInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class BotText(Base):
    __tablename__ = "bot_texts"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    key: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    lang: Mapped[str | None] = mapped_column(String(10), nullable=True)
    banner_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    banner_position: Mapped[str | None] = mapped_column(String(10), nullable=True)
