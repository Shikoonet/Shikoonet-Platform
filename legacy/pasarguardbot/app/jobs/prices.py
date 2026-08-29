import time

from app.db.crud.settings import SettingsManager
from app.logger import LogTag, get_logger
from app.services.pricing.rates import arz_update, ton_arz_update, trx_arz_update

logger = get_logger(__name__)


async def get_prices_and_update():
    start_time = time.time()
    logger.debug("%s get_prices_and_update started", LogTag.JOB)

    usd_price = await arz_update()
    trx_price = await trx_arz_update()
    ton_price = await ton_arz_update()

    if usd_price:
        settings = await SettingsManager().get_settings()
        await SettingsManager().update_setting(settings.id, arz_usd=int(usd_price))
    else:
        logger.warning("Failed to fetch USD price; no update performed.")

    if trx_price:
        settings = await SettingsManager().get_settings()
        await SettingsManager().update_setting(settings.id, arz_trx=int(trx_price))
    else:
        logger.warning("Failed to fetch TRX price; no update performed.")

    if ton_price:
        settings = await SettingsManager().get_settings()
        await SettingsManager().update_setting(settings.id, arz_ton=int(ton_price))
    else:
        logger.warning("Failed to fetch TON price; no update performed.")

    elapsed = time.time() - start_time
    logger.info(
        f"{LogTag.JOB} get_prices_and_update | duration={elapsed:.2f}s, "
        f"usd={'updated' if usd_price else 'failed'}, "
        f"trx={'updated' if trx_price else 'failed'}, "
        f"ton={'updated' if ton_price else 'failed'}"
    )
