from __future__ import annotations

from io import BytesIO

import qrcode

from app.logger import get_logger

logger = get_logger(__name__)


def create_qr_code(text: str, *, filename: str = "qrcode.png") -> BytesIO:
    """Create a QR code image in memory for Telegram upload."""
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=10,
        border=4,
    )
    qr.add_data(text)
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")
    buffer = BytesIO()
    img.save(buffer, format="PNG")
    buffer.seek(0)
    buffer.name = filename
    logger.debug("QR code created in memory as %s", filename)
    return buffer
