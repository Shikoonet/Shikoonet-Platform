import time

from sqlalchemy import JSON, BigInteger, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class BroadcastJob(Base):
    """Broadcast job model for managing message broadcasts to users."""

    __tablename__ = "broadcast_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_by: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)

    # Status: draft, pending_confirm, queued, running, paused, canceled, done, failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", index=True)

    # Target mode: all, active, users_with_active_service
    target_mode: Mapped[str] = mapped_column(String(30), nullable=False, default="all")

    # Payload: JSON containing message data (text, caption, buttons, media identifiers, etc.)
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False)

    # Speed control: delay_ms (milliseconds between sends) or rps (requests per second)
    delay_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=300)
    batch_size: Mapped[int] = mapped_column(Integer, nullable=False, default=50)
    batch_delay_ms: Mapped[int] = mapped_column(
        Integer, nullable=False, default=2000
    )  # Delay between batches in milliseconds

    # Cursor for resuming: last processed user id
    cursor_user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, default=0)

    # Counters
    total_targets: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sent_ok: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sent_fail: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    blocked: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    floodwait_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Timestamps
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False, default=lambda: int(time.time()))
    started_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    finished_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    # Optional error message
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    def __repr__(self):
        return f"<BroadcastJob(id={self.id}, status='{self.status}', target_mode='{self.target_mode}')>"
