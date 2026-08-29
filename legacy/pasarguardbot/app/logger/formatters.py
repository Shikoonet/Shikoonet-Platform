"""Log formatters and console handlers (colored / Rich)."""

from __future__ import annotations

import logging
import sys
from datetime import datetime

from app.logger.config import MESSAGE_PAD

# ANSI colors (fallback when Rich is unavailable)
_LEVEL_COLORS = {
    logging.DEBUG: "\033[36m",  # cyan
    logging.INFO: "\033[32m",  # green
    logging.WARNING: "\033[33m",  # yellow
    logging.ERROR: "\033[31m",  # red
    logging.CRITICAL: "\033[35m",  # magenta
}
_RESET = "\033[0m"
_DIM = "\033[2m"
_BOLD = "\033[1m"


def _supports_color() -> bool:
    if not hasattr(sys.stderr, "isatty") or not sys.stderr.isatty():
        return False
    if sys.platform == "win32":
        try:
            import colorama

            colorama.just_fix_windows_console()
        except ImportError:
            pass
    return True


def _format_fields(record: logging.LogRecord) -> str:
    fields = getattr(record, "structured_fields", None)
    if not fields:
        return ""
    parts = []
    for key, value in fields.items():
        if value is None:
            continue
        text = str(value).replace("\n", " ")
        if " " in text:
            text = repr(text)
        parts.append(f"{key}={text}")
    return " ".join(parts)


class ConsoleFormatter(logging.Formatter):
    """
    Terminal format:
    [12:31:22] INFO     User authenticated        user_id=12345
    """

    def __init__(self, use_color: bool | None = None) -> None:
        super().__init__()
        self.use_color = _supports_color() if use_color is None else use_color

    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created).strftime("%H:%M:%S")
        level = record.levelname
        name = record.name.split(".")[-1][:12]
        msg = record.getMessage()
        fields = _format_fields(record)

        level_pad = f"{level:<8}"
        name_part = f"{name} " if name and name != "root" else ""

        body = msg
        if fields:
            pad = max(MESSAGE_PAD - len(msg), 1)
            body = f"{msg}{' ' * pad}{fields}"

        line = f"[{ts}] {level_pad} {name_part}{body}"

        if record.exc_info and not record.exc_text:
            record.exc_text = self.formatException(record.exc_info)

        if record.exc_text:
            line = f"{line}\n{record.exc_text}"

        if not self.use_color:
            return line

        color = _LEVEL_COLORS.get(record.levelno, "")
        ts_colored = f"{_DIM}[{ts}]{_RESET}"
        level_colored = f"{color}{_BOLD}{level_pad}{_RESET}"
        return f"{ts_colored} {level_colored} {name_part}{body}" + (
            f"\n{color}{record.exc_text}{_RESET}" if record.exc_text else ""
        )


class FileFormatter(logging.Formatter):
    """Single-line records for log files using the configured logging format."""

    def __init__(self, fmt: str | None = None) -> None:
        if fmt is None:
            from config import LOG_FORMAT

            fmt = LOG_FORMAT
        super().__init__(
            fmt=fmt,
            datefmt="%Y-%m-%d %H:%M:%S",
        )

    def format(self, record: logging.LogRecord) -> str:
        fields = _format_fields(record)
        if not fields:
            return super().format(record)

        original_msg = record.msg
        original_args = record.args
        try:
            record.msg = f"{record.getMessage()} | {fields}"
            record.args = ()
            return super().format(record)
        finally:
            record.msg = original_msg
            record.args = original_args


def build_console_handler(level: int, use_rich: bool, log_format: str) -> logging.Handler:
    """Return RichHandler when enabled, else StreamHandler using ``log_format`` from config."""
    if use_rich:
        try:
            from rich.logging import RichHandler

            handler = RichHandler(
                level=level,
                rich_tracebacks=True,
                tracebacks_show_locals=False,
                markup=False,
                show_path=False,
                log_time_format="%H:%M:%S",
            )
            handler.setFormatter(logging.Formatter("%(message)s", datefmt="%H:%M:%S"))
            return handler
        except ImportError:
            pass

    handler = logging.StreamHandler(sys.stderr)
    handler.setLevel(level)
    handler.setFormatter(FileFormatter(log_format))
    return handler
