from sqlalchemy import BigInteger, Column, Float, Integer, String, Text

from app.db.base import Base


class Plan(Base):
    __tablename__ = "plans"

    id = Column(Integer, primary_key=True, autoincrement=True)
    price = Column(Float, nullable=False)
    storage = Column(Float, nullable=False)
    duration = Column(Integer, nullable=False)
    panel_code = Column(Integer, nullable=False)
    plan_type = Column(String(20), nullable=False, default="volume")  # "volume" or "fair_usage"
    data_limit_reset_strategy = Column(
        String(20), nullable=False, default="no_reset"
    )  # "no_reset", "day", "week", "month", "year"
    ip_limit = Column(Integer, nullable=False, default=0)  # 0 means unlimited, otherwise the user limit
    display_button_text = Column(Text, nullable=True)
    button_style = Column(String(20), nullable=True)
    button_icon = Column(BigInteger, nullable=True)
