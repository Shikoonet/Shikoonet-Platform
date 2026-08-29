"""Dynamic Telethon plugin loader."""

from __future__ import annotations

import importlib.util
import sys
import traceback
from pathlib import Path

from app.logger import LogTag, get_logger

logger = get_logger("plugins")


class PluginLoadError(RuntimeError):
    """One or more plugin modules failed to import."""

    def __init__(self, failures: list[tuple[str, Path, BaseException]]):
        self.failures = failures
        lines = [
            f"{len(failures)} plugin(s) failed to load:",
            "",
        ]
        for module_name, module_path, exc in failures:
            lines.append(f"  File: {module_path}")
            lines.append(f"  Module: {module_name}")
            lines.append(f"  Error: {type(exc).__name__}: {exc}")
            lines.append("")
        super().__init__("\n".join(lines).rstrip())


def load_plugins(plugin_name: str, *, module_path: Path | None = None) -> None:
    """Import a plugin module once; skip if already registered in sys.modules."""
    if plugin_name in sys.modules:
        logger.debug("%s '%s' already loaded, skipping", LogTag.PLUGIN, plugin_name)
        return

    path = module_path
    if path is None:
        path = Path(*plugin_name.split(".")).with_suffix(".py")

    if not path.is_file():
        raise FileNotFoundError(f"Plugin module '{plugin_name}' not found at {path.resolve()}")

    spec = importlib.util.spec_from_file_location(plugin_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load plugin '{plugin_name}' from {path.resolve()}")

    module = importlib.util.module_from_spec(spec)
    # Register before exec_module — required for @dataclass(slots=True) on Python 3.14+
    sys.modules[plugin_name] = module
    module.logger = get_logger(plugin_name)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        logger.error(
            "%s Load failed | file=%s module=%s error=%s: %s\n%s",
            LogTag.PLUGIN,
            path.resolve(),
            plugin_name,
            type(exc).__name__,
            exc,
            "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        )
        raise PluginLoadError([(plugin_name, path.resolve(), exc)]) from exc

    sys.modules[plugin_name] = module
    logger.debug("%s Loaded %s (%s)", LogTag.PLUGIN, plugin_name, path.name)


def load_plugins_collect_errors(
    plugin_name: str,
    module_path: Path,
) -> tuple[bool, Path | None, BaseException | None]:
    """Load one plugin; return (ok, path, error) without raising."""
    try:
        load_plugins(plugin_name, module_path=module_path)
        return True, None, None
    except PluginLoadError as e:
        if e.failures:
            _name, path, exc = e.failures[0]
            return False, path, exc
        return False, module_path.resolve(), e
    except Exception as exc:
        logger.error(
            "%s Load failed | file=%s module=%s error=%s: %s\n%s",
            LogTag.PLUGIN,
            module_path.resolve(),
            plugin_name,
            type(exc).__name__,
            exc,
            "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        )
        return False, module_path.resolve(), exc
