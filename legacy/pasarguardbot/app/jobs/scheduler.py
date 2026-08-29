"""APScheduler instance and lifecycle."""

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.logger import LogTag, get_logger

logger = get_logger(__name__)

scheduler = AsyncIOScheduler()


def start_scheduler() -> None:
    """Register all jobs and start the scheduler (call after bot is ready)."""
    from app.jobs.registry import register_all_jobs

    if scheduler.running:
        logger.warning("%s Already running — skipped start", LogTag.SCHEDULER)
        return
    register_all_jobs()
    jobs_count = len(scheduler.get_jobs())
    scheduler.start()
    logger.info("%s Started | jobs=%s", LogTag.SCHEDULER, jobs_count)
