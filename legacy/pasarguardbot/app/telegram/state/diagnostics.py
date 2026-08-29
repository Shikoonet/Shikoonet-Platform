"""Live Redis diagnostics for admin panels."""

from __future__ import annotations

from urllib.parse import urlparse

from app.db.redis import get_redis
from app.telegram.state.keys import get_redis_namespace
from config import REDIS_URL, STATE_TTL_SECONDS

_STEP_FIELD = "_current"


def _redis_host_label() -> str:
    parsed = urlparse(REDIS_URL)
    host = parsed.hostname or "localhost"
    port = parsed.port or 6379
    return f"{host}:{port}"


async def _count_keys(redis, pattern: str, *, limit: int = 10_000) -> int:
    count = 0
    async for _ in redis.scan_iter(match=pattern, count=200):
        count += 1
        if count >= limit:
            break
    return count


async def collect_redis_diagnostics(*, user_samples: int = 8, cache_preview_len: int = 72) -> dict:
    """Collect Redis connection info, key counts, stats cache entries, and sample user state."""
    redis = await get_redis()
    namespace = get_redis_namespace()
    base = {
        "namespace": namespace,
        "host": _redis_host_label(),
        "state_ttl_seconds": STATE_TTL_SECONDS,
    }
    if redis is None:
        return {**base, "available": False, "error": "Redis unavailable (check REDIS_URL)"}

    try:
        await redis.ping()
        info = await redis.info(section="memory")
        clients_info = await redis.info(section="clients")
        db_size = await redis.dbsize()
    except Exception as exc:
        return {**base, "available": False, "error": str(exc)}

    patterns = {
        "user_state": f"{namespace}:user:*",
        "app_cache": f"{namespace}:cache:*",
        "callbacks": f"{namespace}:callback:*",
        "locks": f"{namespace}:lock:*",
    }
    counts = {}
    for name, pattern in patterns.items():
        counts[name] = await _count_keys(redis, pattern)

    stats_cache: list[dict] = []
    async for raw_key in redis.scan_iter(match=f"{namespace}:cache:*", count=200):
        logical = raw_key.replace(f"{namespace}:cache:", "", 1)
        ttl = await redis.ttl(raw_key)
        value = await redis.get(raw_key)
        preview = ""
        if value:
            preview = value[:cache_preview_len] + ("…" if len(value) > cache_preview_len else "")
        stats_cache.append(
            {
                "key": logical,
                "ttl": ttl,
                "bytes": len(value or ""),
                "preview": preview,
            }
        )
    stats_cache.sort(key=lambda item: item["key"])

    users: list[dict] = []
    async for raw_key in redis.scan_iter(match=f"{namespace}:user:*", count=200):
        if len(users) >= user_samples:
            break
        user_id = raw_key.rsplit(":", 1)[-1]
        step = await redis.hget(raw_key, _STEP_FIELD)
        field_count = await redis.hlen(raw_key)
        ttl = await redis.ttl(raw_key)
        extra_keys = []
        if field_count > 1:
            fields = await redis.hkeys(raw_key)
            extra_keys = [f for f in fields if f != _STEP_FIELD][:5]
        users.append(
            {
                "user_id": user_id,
                "step": step or "—",
                "fields": field_count,
                "ttl": ttl,
                "extra_keys": extra_keys,
            }
        )

    return {
        **base,
        "available": True,
        "memory_human": info.get("used_memory_human", "—"),
        "connected_clients": int(clients_info.get("connected_clients", 0) or 0),
        "db_keys": db_size,
        "counts": counts,
        "stats_cache": stats_cache,
        "user_samples": users,
    }
