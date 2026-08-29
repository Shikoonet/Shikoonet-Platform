from datetime import datetime

from sqlalchemy import BigInteger, Boolean, Column, Integer, String

from app.db.base import Base


class DiscountCode(Base):
    __tablename__ = "discount_codes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(100), unique=True, nullable=False)
    discount_percentage = Column(Integer, nullable=False)
    is_public = Column(Boolean, default=True)
    user_id = Column(BigInteger, nullable=True)
    expiration_date = Column(BigInteger, nullable=True)
    usage_limit = Column(Integer, default=1)
    times_used = Column(Integer, default=0)
    created_at = Column(BigInteger, default=lambda: int(datetime.now().timestamp()))

    def __repr__(self):
        return f"<DiscountCode(code={self.code}, discount_percentage={self.discount_percentage}%, user_id={self.user_id}, expiration_date={self.expiration_date}, is_public={self.is_public})>"
