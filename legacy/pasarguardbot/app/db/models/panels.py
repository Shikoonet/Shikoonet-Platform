from __future__ import annotations

from typing import Any

from sqlalchemy import BigInteger, Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import PostgresJSONB


class Panels(Base):
    __tablename__ = "panels"

    code: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    enable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=True)

    base_url: Mapped[str] = mapped_column(String(255), nullable=False)
    tunnel_url: Mapped[str | None] = mapped_column(String(255), nullable=True)

    username: Mapped[str] = mapped_column(String(50), nullable=False)
    password: Mapped[str] = mapped_column(String(512), nullable=False)
    cookie: Mapped[str] = mapped_column(String(500), nullable=False)
    auth_type: Mapped[str] = mapped_column(String(20), nullable=False, default="password", insert_default="password")

    button_settings: Mapped[dict[str, Any]] = mapped_column(
        PostgresJSONB,
        nullable=False,
        default=dict,
        insert_default=dict,
    )
    subscription_settings: Mapped[dict[str, Any]] = mapped_column(
        PostgresJSONB,
        nullable=False,
        default=dict,
        insert_default=dict,
    )
    test_settings: Mapped[dict[str, Any]] = mapped_column(
        PostgresJSONB,
        nullable=False,
        default=dict,
        insert_default=dict,
    )
    renewal_settings: Mapped[dict[str, Any]] = mapped_column(
        PostgresJSONB,
        nullable=False,
        default=dict,
        insert_default=dict,
    )
    feature_settings: Mapped[dict[str, Any]] = mapped_column(
        PostgresJSONB,
        nullable=False,
        default=dict,
        insert_default=dict,
    )
