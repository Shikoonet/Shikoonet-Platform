from sqlalchemy import BigInteger, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ResellerBillingSnapshot(Base):
    __tablename__ = "reseller_billing_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_code: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    used_traffic: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    billed_amount: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    snapshot_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
