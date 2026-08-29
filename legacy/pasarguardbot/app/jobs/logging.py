"""Job logging helpers."""

from __future__ import annotations

import functools
import time
from collections.abc import Callable, Coroutine
from typing import Any, ParamSpec, TypeVar

from app.logger import LogTag, get_logger

P = ParamSpec("P")
R = TypeVar("R")


def job_logged(job_id: str) -> Callable[[Callable[P, Coroutine[Any, Any, R]]], Callable[P, Coroutine[Any, Any, R]]]:
    """Log job start/complete at DEBUG; re-raise failures after logging."""

    def decorator(func: Callable[P, Coroutine[Any, Any, R]]) -> Callable[P, Coroutine[Any, Any, R]]:
        logger = get_logger(func.__module__)

        @functools.wraps(func)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            start = time.time()
            logger.debug("%s %s started", LogTag.JOB, job_id)
            try:
                result = await func(*args, **kwargs)
            except Exception:
                logger.exception("%s %s failed after %.2fs", LogTag.JOB, job_id, time.time() - start)
                raise
            logger.debug("%s %s completed in %.2fs", LogTag.JOB, job_id, time.time() - start)
            return result

        return wrapper

    return decorator
