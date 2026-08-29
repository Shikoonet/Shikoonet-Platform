from sqlalchemy import BigInteger, Column, String

from app.db.base import Base


class Channel(Base):
    __tablename__ = "channels"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=False)
    link = Column(String(100), nullable=False)
    title = Column(String(100), nullable=False)
