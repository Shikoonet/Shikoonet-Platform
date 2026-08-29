from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AppFile(Base):
    __tablename__ = "app_files"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    app_key: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_url: Mapped[str] = mapped_column(String(500), nullable=False)
    message_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    chat_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    topic_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    tag_name: Mapped[str] = mapped_column(String(100), nullable=True)
    file_size_mb: Mapped[float] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    def __repr__(self):
        return f"<AppFile(id={self.id}, app_key='{self.app_key}', file_name='{self.file_name}')>"
