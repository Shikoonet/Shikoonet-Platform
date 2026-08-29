from sqlalchemy import BigInteger, Boolean, Column, Text

from app.db.base import Base


class ManualCard(Base):
    __tablename__ = "manual_cards"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    number = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    active = Column(Boolean, default=False)
