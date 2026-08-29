from __future__ import annotations

import httpx

from app.logger import get_logger

logger = get_logger(__name__)


async def get_usdt_price() -> float | None:
    url = "https://apiv2.nobitex.ir/market/stats?srcCurrency=trx&dstCurrency=usdt"

    async with httpx.AsyncClient() as client:
        response = await client.get(url, timeout=120)

    if response.status_code != 200:
        return None

    data = response.json()
    trx_usdt_stats = data.get("stats", {}).get("trx-usdt", {})

    if data.get("status") != "ok" or "bestSell" not in trx_usdt_stats:
        return None

    return float(trx_usdt_stats["bestSell"])


async def arz_update():
    try:
        url = "https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls"
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=120)
        if response.status_code != 200:
            logger.error("Error fetching USDT price: %s", response.status_code)
            return False

        data = response.json()
        stats = data.get("stats", {}).get("usdt-rls", {})
        if data.get("status") != "ok" or "bestSell" not in stats:
            logger.error("USDT data not found or status not OK.")
            return False

        dollar = stats["bestSell"]
        return int(dollar[:-1])

    except httpx.RequestError as e:
        logger.error("Network error while fetching USDT price: %s", e)
    except ValueError as e:
        logger.error("Error parsing USDT price: %s", e)
    except Exception as e:
        logger.error("Unexpected error in arz_update: %s", e)

    return False


async def trx_arz_update():
    try:
        url = "https://apiv2.nobitex.ir/market/stats?srcCurrency=trx&dstCurrency=rls"
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=120)
        if response.status_code != 200:
            logger.error("Error fetching TRX price: %s", response.status_code)
            return False

        data = response.json()
        stats = data.get("stats", {}).get("trx-rls", {})
        if data.get("status") != "ok" or "bestSell" not in stats:
            logger.error("TRX data not found or status not OK.")
            return False

        price = stats["bestSell"]
        return int(price[:-1])

    except httpx.RequestError as e:
        logger.error("Network error while fetching TRX price: %s", e)
    except ValueError as e:
        logger.error("Error parsing TRX price: %s", e)
    except Exception as e:
        logger.error("Unexpected error in trx_arz_update: %s", e)

    return False


async def ton_arz_update():
    try:
        url = "https://apiv2.nobitex.ir/market/stats?srcCurrency=gram&dstCurrency=rls"
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=120)
        if response.status_code != 200:
            logger.error("Error fetching TON price: %s", response.status_code)
            return False

        data = response.json()
        stats = data.get("stats", {}).get("gram-rls", {})
        if data.get("status") != "ok" or "bestSell" not in stats:
            logger.error("TON data not found or status not OK.")
            return False

        price = stats["bestSell"]
        return int(price[:-1])

    except httpx.RequestError as e:
        logger.error("Network error while fetching TON price: %s", e)
    except ValueError as e:
        logger.error("Error parsing TON price: %s", e)
    except Exception as e:
        logger.error("Unexpected error in ton_arz_update: %s", e)

    return False
