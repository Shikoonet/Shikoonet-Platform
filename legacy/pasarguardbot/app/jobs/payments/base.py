"""
Base payment processor class

This is the base class that all payment processors should inherit from.
"""

from abc import ABC, abstractmethod

from app.logger import get_logger

logger = get_logger(__name__)


class BasePaymentProcessor(ABC):
    def __init__(self, payment_type: str):
        self.payment_type = payment_type

    @abstractmethod
    async def check_payments(self):
        pass

    async def expire_payment(self, payment, settings):
        logger.info(f"Payment {payment.order_id} expired (type: {self.payment_type})")
