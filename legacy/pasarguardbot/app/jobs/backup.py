"""Scheduled bot backup job."""

from __future__ import annotations

from app.db.crud.settings import SettingsManager
from app.jobs.scheduler import scheduler
from app.logger import LogTag, get_logger
from app.services.backup import BACKUP_JOB_ID, run_backup_and_send

logger = get_logger(__name__)


async def bot_backup_job() -> None:
    result = await run_backup_and_send(trigger="auto")
    if result.ok:
        logger.info("%s Backup sent successfully", LogTag.JOB)
    else:
        logger.warning("%s Backup skipped/failed: %s", LogTag.JOB, result.message)


async def get_backup_interval_hours() -> int:
    settings = await SettingsManager().get_settings()
    if not settings:
        return 24
    return max(0, int(getattr(settings, "backup_interval_hours", 24) or 0))


def register_backup_job_placeholder() -> None:
    """Register paused placeholder until settings are loaded."""
    scheduler.add_job(
        bot_backup_job,
        "interval",
        hours=24,
        id=BACKUP_JOB_ID,
        replace_existing=True,
    )
    job = scheduler.get_job(BACKUP_JOB_ID)
    if job:
        job.pause()


def reschedule_backup_job(hours: int) -> None:
    """Apply interval from settings. hours=0 pauses automatic backups."""
    hours = max(0, int(hours))
    existing = scheduler.get_job(BACKUP_JOB_ID)

    if hours <= 0:
        if existing:
            existing.pause()
            logger.info("%s Backup job paused (interval=0)", LogTag.SCHEDULER)
        return

    if existing:
        scheduler.reschedule_job(BACKUP_JOB_ID, trigger="interval", hours=hours)
        job = scheduler.get_job(BACKUP_JOB_ID)
        if job:
            job.resume()
        logger.info("%s Backup job rescheduled | every=%sh", LogTag.SCHEDULER, hours)
        return

    scheduler.add_job(
        bot_backup_job,
        "interval",
        hours=hours,
        id=BACKUP_JOB_ID,
        replace_existing=True,
    )
    logger.info("%s Backup job added | every=%sh", LogTag.SCHEDULER, hours)


async def bootstrap_backup_job() -> None:
    hours = await get_backup_interval_hours()
    reschedule_backup_job(hours)
