"""Centralized logging setup and helpers for the PasarGuardBot application."""

from __future__ import annotations

import atexit
import logging
import logging.handlers
import queue
import threading
from pathlib import Path
from typing import Any

from app.logger.config import (
    APP_LOG_FILENAME,
    APP_LOGGER_NAME,
    ERROR_LOG_FILENAME,
    QUIET_LOGGERS,
    resolve_log_level,
)
from app.logger.formatters import FileFormatter, build_console_handler
from config import (
    LOG_APP_BACKUP_COUNT,
    LOG_APP_MAX_BYTES,
    LOG_DIR,
    LOG_ERROR_BACKUP_COUNT,
    LOG_ERROR_MAX_BYTES,
    LOG_FORMAT,
    LOG_LEVEL,
    LOG_TO_FILE,
    LOG_USE_RICH,
)

from .tags import LogTag

_configured = False
_queue_listener: logging.handlers.QueueListener | None = None
_log_queue: queue.Queue[Any] | None = None


class StructuredLogRecordFactory:
    """Attach ``structured_fields`` from the ``extra`` dict to every log record."""

    _original_factory = logging.getLogRecordFactory()

    @classmethod
    def install(cls) -> None:
        logging.setLogRecordFactory(cls._factory)

    @classmethod
    def _factory(cls, *args: Any, **kwargs: Any) -> logging.LogRecord:
        record = cls._original_factory(*args, **kwargs)
        extra = kwargs.get("extra") or {}
        fields = extra.get("structured_fields")
        if fields:
            record.structured_fields = fields
        return record


class DuplicateExceptionFilter(logging.Filter):
    """Suppress identical consecutive exception tracebacks (reduces spam)."""

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._last_key: tuple[Any, ...] | None = None

    def filter(self, record: logging.LogRecord) -> bool:
        if not record.exc_info:
            return True
        exc_type, exc_value, _ = record.exc_info
        key = (record.name, record.funcName, exc_type, str(exc_value))
        with self._lock:
            if key == self._last_key:
                return False
            self._last_key = key
        return True


def format_fields(**kwargs: Any) -> dict[str, Any]:
    """Build structured key=value fields for log calls."""
    return {k: v for k, v in kwargs.items() if v is not None}


def get_logger(name: str | None = None) -> logging.Logger:
    """Return a logger under the ``PasarGuardBot`` namespace."""
    if not _configured:
        setup_logging(
            level=LOG_LEVEL,
            log_to_file=LOG_TO_FILE,
            use_rich=LOG_USE_RICH,
            log_format=LOG_FORMAT,
        )
    if name is None or name == APP_LOGGER_NAME:
        return logging.getLogger(APP_LOGGER_NAME)
    if name.startswith(f"{APP_LOGGER_NAME}."):
        return logging.getLogger(name)
    return logging.getLogger(f"{APP_LOGGER_NAME}.{name}")


def setup_logging(
    *,
    level: str | int | None = None,
    log_dir: str | Path | None = None,
    log_to_file: bool | None = None,
    use_rich: bool | None = None,
    log_format: str | None = None,
) -> logging.Logger:
    """Configure application logging once. Safe to call multiple times."""
    global _configured, _queue_listener, _log_queue

    if _configured:
        return get_logger()

    log_directory = Path(log_dir or LOG_DIR)
    log_directory.mkdir(parents=True, exist_ok=True)

    log_level = resolve_log_level(level if isinstance(level, str) else None)
    if isinstance(level, int):
        log_level = level

    file_enabled = LOG_TO_FILE if log_to_file is None else log_to_file
    rich_enabled = LOG_USE_RICH if use_rich is None else use_rich
    file_format = log_format or LOG_FORMAT

    StructuredLogRecordFactory.install()

    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(logging.WARNING)

    app_logger = logging.getLogger(APP_LOGGER_NAME)
    app_logger.handlers.clear()
    app_logger.propagate = False
    app_logger.setLevel(log_level)

    console_handler = build_console_handler(log_level, rich_enabled, file_format)
    console_handler.addFilter(DuplicateExceptionFilter())
    app_logger.addHandler(console_handler)

    if file_enabled:
        _log_queue = queue.Queue(-1)
        queue_handler = logging.handlers.QueueHandler(_log_queue)

        app_file = logging.handlers.RotatingFileHandler(
            log_directory / APP_LOG_FILENAME,
            maxBytes=LOG_APP_MAX_BYTES,
            backupCount=LOG_APP_BACKUP_COUNT,
            encoding="utf-8",
        )
        app_file.setLevel(logging.INFO)
        app_file.setFormatter(FileFormatter(file_format))

        error_file = logging.handlers.RotatingFileHandler(
            log_directory / ERROR_LOG_FILENAME,
            maxBytes=LOG_ERROR_MAX_BYTES,
            backupCount=LOG_ERROR_BACKUP_COUNT,
            encoding="utf-8",
        )
        error_file.setLevel(logging.ERROR)
        error_file.setFormatter(FileFormatter(file_format))

        _queue_listener = logging.handlers.QueueListener(
            _log_queue,
            app_file,
            error_file,
            respect_handler_level=True,
        )
        _queue_listener.start()
        app_logger.addHandler(queue_handler)

    for lib_name, lib_level in QUIET_LOGGERS.items():
        logging.getLogger(lib_name).setLevel(lib_level)

    _configured = True
    return app_logger


def shutdown_logging() -> None:
    """Flush and stop background log listener (call on process exit)."""
    global _queue_listener
    if _queue_listener is not None:
        _queue_listener.stop()
        _queue_listener = None


def log(
    logger: logging.Logger,
    level: int,
    message: str,
    *,
    exc_info: bool | BaseException | None = None,
    **fields: Any,
) -> None:
    """Log with optional structured fields (key=value suffix on console)."""
    extra = {"structured_fields": format_fields(**fields)} if fields else None
    logger.log(level, message, exc_info=exc_info, extra=extra)


def log_exception(
    logger: logging.Logger,
    message: str,
    *,
    exc: BaseException | None = None,
    **fields: Any,
) -> None:
    """Log an error with traceback (deduplicated by handler filter)."""
    log(logger, logging.ERROR, message, exc_info=exc or True, **fields)


def log_flood_wait(
    logger: logging.Logger,
    seconds: int,
    *,
    context: str = "",
    user_id: int | None = None,
    **fields: Any,
) -> None:
    """Standard FloodWait log line."""
    log(
        logger,
        logging.WARNING,
        "Telegram FloodWait",
        wait_seconds=seconds,
        context=context or None,
        user_id=user_id,
        **fields,
    )


def log_startup_banner(logger: logging.Logger) -> None:
    """Print a concise startup banner (no multi-line box spam)."""
    log(logger, logging.INFO, f"{LogTag.BOOT} PasarGuardBot started")


def init_logging() -> logging.Logger:
    """Configure logging from config and emit the startup banner. Call once at process entry."""
    setup_logging(
        level=LOG_LEVEL,
        log_to_file=LOG_TO_FILE,
        use_rich=LOG_USE_RICH,
        log_format=LOG_FORMAT,
    )
    app_logger = get_logger()
    log_startup_banner(app_logger)
    return app_logger


atexit.register(shutdown_logging)
