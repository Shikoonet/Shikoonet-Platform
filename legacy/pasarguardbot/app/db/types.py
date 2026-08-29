"""Shared SQLAlchemy column types."""

from __future__ import annotations

from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import JSONB

PostgresJSONB = JSON().with_variant(JSONB(none_as_null=True), "postgresql")

__all__ = ["PostgresJSONB"]
