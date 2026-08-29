from sqlalchemy import BigInteger, Boolean, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class LogChannel(Base):
    __tablename__ = "log_channels"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    log_type: Mapped[str] = mapped_column(String(50), nullable=False)  # manual_card, auto_card, crypto, stars, other
    destination_type: Mapped[str] = mapped_column(String(20), nullable=False)
    chat_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    topic_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
