"""Constants for admin stats/info bot panel."""

from zoneinfo import ZoneInfo

STATS_PREFIX = "stats:"
STATS_CACHE_TTL = 60
HIDDEN_LINK = "[\u200b](https://s6.uupload.ir/files/info_8di.png)"
TEHRAN_TZ = ZoneInfo("Asia/Tehran")
UTC_TZ = ZoneInfo("UTC")

REVENUE_PERIODS: dict[str, str] = {
    "1d": "📅 امروز",
    "yesterday": "📅 دیروز",
    "2d": "📅 ۲ روز",
    "3d": "📅 ۳ روز",
    "4d": "📅 ۴ روز",
    "5d": "📅 ۵ روز",
    "6d": "📅 ۶ روز",
    "7d": "📅 ۷ روز اخیر",
    "7d_ago": "📅 دقیقاً ۷ روز پیش",
    "this_month": "🗓 این ماه",
    "1m": "🗓 ۱ ماه",
    "2m": "🗓 ۲ ماه",
    "3m": "🗓 ۳ ماه",
    "all": "🌍 کل",
}

# Re-export for helpers that use timedelta with TEHRAN_TZ
__all__ = [
    "HIDDEN_LINK",
    "REVENUE_PERIODS",
    "STATS_CACHE_TTL",
    "STATS_PREFIX",
    "TEHRAN_TZ",
    "UTC_TZ",
]
