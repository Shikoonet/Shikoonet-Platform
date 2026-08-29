"""Single source of truth for /start deep-link parameters."""

from __future__ import annotations

from app.telegram.shared.utils.help_download import apps

# Opens welcome menu (official restart link).
WELCOME_START_PARAMS = frozenset({"start"})

# Legacy / unused params — still open welcome, but hidden from admin preset lists.
DEPRECATED_START_PARAMS = frozenset({"kenzo", "home", "update"})

MAIN_START_PARAMS: dict[str, tuple[str, str]] = {
    "start": ("🏠 شروع / بروزرسانی", "لینک شروع مجدد و بروزرسانی منوی ربات"),
    "free": ("📥 سرویس تست", "لینک دریافت سرویس تست"),
    "buy": ("🛍 خرید سرویس", "لینک خرید سرویس"),
    "charge": ("💰 افزایش موجودی", "لینک افزایش موجودی"),
}

_MAIN_ORDER = ("start", "free", "buy", "charge")


def _app_start_params() -> dict[str, tuple[str, str]]:
    result: dict[str, tuple[str, str]] = {}
    for key, app in apps.items():
        param = app.get("start_param")
        if not param:
            continue
        display = app.get("display_name", key)
        result[param] = (f"📦 {display}", f"دانلود اپ {display}")
    return result


def get_app_start_param_order() -> tuple[str, ...]:
    return tuple(app["start_param"] for app in apps.values() if app.get("start_param"))


def get_documented_start_params() -> dict[str, tuple[str, str]]:
    """Main + app download params shown in admin / message builder."""
    merged = dict(MAIN_START_PARAMS)
    merged.update(_app_start_params())
    return merged


def get_documented_param_order() -> tuple[str, ...]:
    return _MAIN_ORDER + get_app_start_param_order()


def find_app_key_by_start_param(param: str | None) -> str | None:
    if not param:
        return None
    for key, app in apps.items():
        if app.get("start_param") == param:
            return key
    return None


def is_welcome_start_param(param: str | None) -> bool:
    if not param:
        return True
    lowered = param.lower()
    return lowered in WELCOME_START_PARAMS or lowered in DEPRECATED_START_PARAMS


def is_documented_start_param(param: str | None) -> bool:
    return bool(param and param in get_documented_start_params())
