from sqlalchemy import JSON, BigInteger, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class HelpButton(Base):
    __tablename__ = "help_buttons"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    button_number: Mapped[int] = mapped_column(
        Integer, nullable=False, unique=True
    )  # 1-8 link buttons, 9+ download apps
    button_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    button_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    button_style: Mapped[str | None] = mapped_column(String(20), nullable=True)  # primary | danger | success
    button_icon: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # custom emoji document id
    # Download app fields (when set, row is a download app; button_number 9+)
    callback_key: Mapped[str | None] = mapped_column(String(80), nullable=True, unique=True, index=True)
    repo_owner: Mapped[str | None] = mapped_column(String(120), nullable=True)
    repo_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    categories: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # legacy; prefer download_targets
    download_targets: Mapped[list | None] = mapped_column(JSON, nullable=True)  # [{id, button_text, patterns, ...}]
    default_file: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ios_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Text-only app (no GitHub): show this message when user clicks the button
    custom_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    def __repr__(self):
        return f"<HelpButton(id={self.id}, number={self.button_number}, text='{self.button_text}', url='{self.button_url}')>"
