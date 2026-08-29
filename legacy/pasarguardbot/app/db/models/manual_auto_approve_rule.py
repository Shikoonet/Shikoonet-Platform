from sqlalchemy import BigInteger, Boolean, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ManualAutoApproveRule(Base):
    """Rule for timed auto-approval of manual card deposits based on user history."""

    __tablename__ = "manual_auto_approve_rules"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    min_successful_tx: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    max_successful_tx: Mapped[int | None] = mapped_column(Integer, nullable=True)
    auto_approve_delay_minutes: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="1")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
