import tomllib
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from app.logger import LogTag, get_logger

logger = get_logger(__name__)


def get_app_version() -> str:
    try:
        return version("app")
    except PackageNotFoundError:
        data = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
        return data["project"]["version"]


def v(pkg: str) -> str:
    try:
        return version(pkg)
    except PackageNotFoundError:
        return "unknown"


def get_telethon_layer() -> str:
    try:
        from telethon.tl.alltlobjects import LAYER

        return str(LAYER)
    except ImportError:
        return "unknown"


@dataclass(frozen=True)
class Versions:
    app: str
    telethon: str
    telethon_layer: str
    fastapi: str
    pasarguard: str


VERSIONS = Versions(
    app=get_app_version(),
    telethon=v("telethon"),
    telethon_layer=get_telethon_layer(),
    fastapi=v("fastapi"),
    pasarguard=v("pasarguard"),
)


def log_runtime_versions() -> None:
    """Log dependency versions once at startup (not on import)."""
    logger.info(
        "%s app=%s telethon=%s layer=%s fastapi=%s pasarguard=%s",
        LogTag.VERSION,
        VERSIONS.app,
        VERSIONS.telethon,
        VERSIONS.telethon_layer,
        VERSIONS.fastapi,
        VERSIONS.pasarguard,
    )
