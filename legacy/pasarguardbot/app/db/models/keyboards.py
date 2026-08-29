from sqlalchemy import BigInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class KeyboardButton(Base):
    __tablename__ = "keyboard_buttons"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    button_key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    button_text: Mapped[str] = mapped_column(Text, nullable=False)
    button_style: Mapped[str | None] = mapped_column(String(20), nullable=True)
    button_icon: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    def __repr__(self):
        return f"<KeyboardButton(id={self.id}, key='{self.button_key}', text='{self.button_text}')>"
