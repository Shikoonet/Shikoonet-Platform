"""Temporary per-user Redis locks."""

from __future__ import annotations

from app.db.redis import get_redis
from app.logger import get_logger
from app.telegram.state.keys import build_lock_key
from config import LOCK_TTL_SECONDS

logger = get_logger(__name__)


async def acquire_user_lock(
    user_id: int,
    lock_name: str,
    ttl: int | None = None,
) -> bool:
    """Acquire lock; returns True only if lock was acquired."""
    redis = await get_redis()
    if redis is None:
        return True
    seconds = ttl if ttl is not None else LOCK_TTL_SECONDS
    key = build_lock_key(user_id, lock_name)
    try:
        return bool(await redis.set(key, "1", nx=True, ex=seconds))
    except Exception as exc:
        logger.warning("Redis acquire_user_lock(%s, %s): %s", user_id, lock_name, exc)
        return True


async def release_user_lock(user_id: int, lock_name: str) -> None:
    redis = await get_redis()
    if redis is None:
        return
    try:
        await redis.delete(build_lock_key(user_id, lock_name))
    except Exception as exc:
        logger.warning("Redis release_user_lock(%s, %s): %s", user_id, lock_name, exc)


async def is_user_locked(user_id: int, lock_name: str) -> bool:
    redis = await get_redis()
    if redis is None:
        return False
    try:
        return bool(await redis.exists(build_lock_key(user_id, lock_name)))
    except Exception as exc:
        logger.warning("Redis is_user_locked(%s, %s): %s", user_id, lock_name, exc)
        return False
