"""Callback handlers for admin send2all."""

import asyncio

from telethon import Button, errors, events

from app import Kenzo
from app.logger import get_logger
from app.services.broadcast.manager import broadcast_manager
from app.services.broadcast.markup import deserialize_buttons
from app.services.broadcast.payload_format import format_label, is_text_only_payload, set_message_type
from app.services.telegram.rich_message import send_rich_message
from app.telegram.admin.send2all import keyboards, states, texts
from app.telegram.keyboards.admin import panel_back
from app.telegram.state import set_step
from config import ADMIN_ID

logger = get_logger(__name__)

_monitor_tasks: set[asyncio.Task] = set()
BROADCAST_MONITOR_POLL_SECONDS = 5


async def _persist_monitor_message_id(job_id: int, msg_id: int) -> None:
    job = await broadcast_manager.job_crud.get_job(job_id)
    if not job:
        return
    payload = dict(job.payload_json)
    if payload.get("_monitor_msg_id") == msg_id:
        return
    payload["_monitor_msg_id"] = msg_id
    await broadcast_manager.job_crud.update_job(job_id, payload_json=payload)


def _start_monitor_task(message, job_id: int, admin_id: int) -> asyncio.Task:
    monitor_task = asyncio.create_task(monitor_broadcast_status(message, job_id, admin_id))
    _monitor_tasks.add(monitor_task)
    monitor_task.add_done_callback(_monitor_tasks.discard)
    return monitor_task


async def resume_broadcast_monitors() -> None:
    """Restore live status messages after bot restart for running/queued/paused jobs."""
    jobs = []
    seen_ids: set[int] = set()

    active_job = await broadcast_manager.job_crud.get_active_job()
    if active_job:
        jobs.append(active_job)
        seen_ids.add(active_job.id)

    paused_job = await broadcast_manager.job_crud.get_paused_job()
    if paused_job and paused_job.id not in seen_ids:
        jobs.append(paused_job)
        seen_ids.add(paused_job.id)

    for queued_job in await broadcast_manager.job_crud.get_queued_jobs():
        if queued_job.id not in seen_ids:
            jobs.append(queued_job)
            seen_ids.add(queued_job.id)

    if not jobs:
        return

    for job in jobs:
        admin_id = job.created_by
        message = None
        monitor_msg_id = job.payload_json.get("_monitor_msg_id")
        if monitor_msg_id:
            try:
                fetched = await Kenzo.get_messages(admin_id, ids=monitor_msg_id)
                if fetched:
                    message = fetched[0]
            except Exception as e:
                logger.warning(f"Could not load stored monitor message for job {job.id}: {e}")

        if message is None:
            message = await Kenzo.send_message(admin_id, texts.resumed_monitor_header(job))
            await _persist_monitor_message_id(job.id, message.id)
        else:
            try:
                await message.edit(texts.resumed_monitor_header(job), buttons=None)
            except Exception as e:
                logger.warning(f"Could not edit stored monitor message for job {job.id}: {e}")

        _start_monitor_task(message, job.id, admin_id)
        logger.info(f"Resumed broadcast monitor for job {job.id} (admin={admin_id})")


async def _edit_settings_view(event, job_id: int):
    job = await broadcast_manager.job_crud.get_job(job_id)
    if not job:
        await event.answer("❌ کار پیدا نشد!", alert=True)
        return None
    await event.edit(texts.settings_text(job), buttons=keyboards.settings_buttons(job_id, job))
    return job


def _preview_format_name(job) -> str | None:
    payload = job.payload_json
    if is_text_only_payload(payload) or payload.get("parse_mode"):
        return format_label(payload.get("parse_mode"))
    return None


async def _edit_preview_view(event, job, *, target_count: int | None = None):
    count = target_count if target_count is not None else (job.total_targets or 0)
    is_forward = bool(job.payload_json.get("is_forward"))
    estimated_seconds = texts.calculate_estimated_time(count, job.delay_ms, job.batch_size, job.batch_delay_ms)
    await event.edit(
        texts.preview_text(
            is_forward=is_forward,
            target_count=count,
            mode_name=texts.MODE_NAMES_SETTINGS.get(job.target_mode, job.target_mode),
            delay_ms=job.delay_ms,
            batch_size=job.batch_size,
            batch_delay_str=texts.format_batch_delay(job.batch_delay_ms),
            estimated_time_str=texts.format_duration(estimated_seconds),
            format_name=_preview_format_name(job),
        ),
        buttons=keyboards.confirm_buttons(job.id),
    )


async def _edit_job_detail_view(event, job):
    await event.edit(
        texts.job_detail_text(job),
        buttons=keyboards.job_detail_buttons(job.id, status=job.status),
    )


async def safe_answer(event, message: str = "", alert: bool = False):
    """Safely answer callback query, ignoring expired queries."""
    try:
        await event.answer(message, alert=alert)
    except errors.QueryIdInvalidError:
        pass
    except Exception as e:
        logger.debug(f"Error answering callback: {e}")


async def callback_handler(event):
    """Handle callback queries for broadcast management"""
    if not event.is_private:
        return

    sender_id = event.sender_id
    if sender_id not in ADMIN_ID:
        return

    data = event.data.decode() if isinstance(event.data, bytes) else event.data

    try:
        # Broadcast confirm
        if data.startswith("broadcast_confirm:"):
            job_id = int(data.split(":")[1])
            job = await broadcast_manager.job_crud.get_job(job_id)

            # Check if there's an active broadcast
            active_job = await broadcast_manager.job_crud.get_active_job()
            if active_job and active_job.id != job_id:
                # Another broadcast is running — mark as queued (confirmed, waiting for turn)
                await event.answer()
                await broadcast_manager.job_crud.update_job(job_id, status="queued")
                queue_position = await broadcast_manager.job_crud.get_queue_position(job_id)
                active_status = await broadcast_manager.get_status(active_job.id)
                active_mode = texts.MODE_NAMES_EMOJI.get(active_job.target_mode, active_job.target_mode)
                active_progress = active_status.get("progress_percent", 0) if active_status else 0
                job_mode = texts.MODE_NAMES_EMOJI.get(job.target_mode, job.target_mode)

                queue_text = texts.queue_status_text(
                    job_id=job_id,
                    job_mode=job_mode,
                    job_targets=job.total_targets or 0,
                    queue_position=queue_position,
                    active_mode=active_mode,
                    active_progress=active_progress,
                )

                await event.edit(queue_text)
                await set_step(user_id=sender_id, step=states.PANEL_STEP)

                status_message = await event.get_message()
                _start_monitor_task(status_message, job_id, sender_id)
            else:
                # No active broadcast, start immediately
                await event.answer()
                status_message = await event.get_message()
                await status_message.edit(texts.STARTING_TEXT)

                monitor_task = _start_monitor_task(status_message, job_id, sender_id)

                success, start_message = await broadcast_manager.confirm_start(job_id)

                if success:
                    await set_step(user_id=sender_id, step=states.PANEL_STEP)
                else:
                    try:
                        await status_message.edit(f"❌ {start_message}")
                    except Exception:
                        await event.answer(start_message, alert=True)
                    monitor_task.cancel()

        # Broadcast test
        elif data.startswith("broadcast_test:"):
            job_id = int(data.split(":")[1])
            success, message = await broadcast_manager.send_test(job_id, sender_id)

            await event.answer(message, alert=not success)

        # Broadcast settings
        elif data.startswith("broadcast_settings:"):
            job_id = int(data.split(":")[1])
            await _edit_settings_view(event, job_id)
            await set_step(user_id=sender_id, step=states.BROADCAST_SETTINGS_STEP)

        # Broadcast cancel
        elif data.startswith("broadcast_cancel:"):
            job_id = int(data.split(":")[1])
            success, message = await broadcast_manager.cancel_job(job_id)

            if success:
                await event.edit("❌ ارسال همگانی لغو شد.")
                await set_step(user_id=sender_id, step=states.PANEL_STEP)
            else:
                await event.answer(message, alert=True)

        # Broadcast pause/resume
        elif data.startswith("broadcast_pause:"):
            job_id = int(data.split(":")[1])
            success, message = await broadcast_manager.pause_job(job_id)
            await safe_answer(event, message, alert=not success)

            # Refresh job details if from detail view
            if success:
                await asyncio.sleep(0.3)
                job = await broadcast_manager.job_crud.get_job(job_id)
                if job and "broadcast_job_detail" not in data:
                    # From monitoring view - don't change anything
                    return
                if job:
                    await _edit_job_detail_view(event, job)

        elif data.startswith("broadcast_resume:"):
            job_id = int(data.split(":")[1])
            success, message = await broadcast_manager.resume_job(job_id)
            await safe_answer(event, message, alert=not success)

            # Refresh job details if from detail view
            if success:
                await asyncio.sleep(0.3)
                job = await broadcast_manager.job_crud.get_job(job_id)
                if job and "broadcast_job_detail" not in data:
                    # From monitoring view - don't change anything
                    return
                if job:
                    await _edit_job_detail_view(event, job)

        # Back to confirmation
        elif data.startswith("broadcast_back:"):
            job_id = int(data.split(":")[1])
            job = await broadcast_manager.job_crud.get_job(job_id)
            if not job:
                await event.answer("❌ کار پیدا نشد!", alert=True)
                return

            await _edit_preview_view(event, job)
            await set_step(user_id=sender_id, step=states.BROADCAST_CONFIRM_STEP)

        # Settings: Set delay - Show selection menu
        elif data.startswith("broadcast_set_delay:"):
            job_id = int(data.split(":")[1])
            job = await broadcast_manager.job_crud.get_job(job_id)
            if not job:
                await event.answer("❌ کار پیدا نشد!", alert=True)
                return
            await event.edit(
                texts.DELAY_SELECTION_TEXT,
                buttons=keyboards.delay_selection_buttons(job_id, job),
            )

        # Settings: Set batch size - Show selection menu
        elif data.startswith("broadcast_set_batch:"):
            job_id = int(data.split(":")[1])
            job = await broadcast_manager.job_crud.get_job(job_id)
            if not job:
                await event.answer("❌ کار پیدا نشد!", alert=True)
                return
            await event.edit(
                texts.BATCH_SELECTION_TEXT,
                buttons=keyboards.batch_selection_buttons(job_id, job),
            )

        # Settings: Set target mode - Show selection menu
        elif data.startswith("broadcast_set_mode:"):
            job_id = int(data.split(":")[1])
            job = await broadcast_manager.job_crud.get_job(job_id)
            if not job:
                await event.answer("❌ کار پیدا نشد!", alert=True)
                return
            await event.edit(
                texts.MODE_SELECTION_TEXT,
                buttons=keyboards.mode_selection_buttons(job_id, job),
            )

        elif data.startswith("broadcast_set_format:"):
            job_id = int(data.split(":")[1])
            job = await broadcast_manager.job_crud.get_job(job_id)
            if not job:
                await event.answer("❌ کار پیدا نشد!", alert=True)
                return
            await event.edit(
                texts.FORMAT_SELECTION_TEXT,
                buttons=keyboards.format_selection_buttons(job_id, job),
            )

        # Settings: Set batch delay - Show selection menu
        elif data.startswith("broadcast_set_batch_delay:"):
            job_id = int(data.split(":")[1])
            job = await broadcast_manager.job_crud.get_job(job_id)
            if not job:
                await event.answer("❌ کار پیدا نشد!", alert=True)
                return
            await event.edit(
                texts.BATCH_DELAY_SELECTION_TEXT,
                buttons=keyboards.batch_delay_selection_buttons(job_id, job),
            )

        # Apply delay selection
        elif data.startswith("broadcast_apply_delay:"):
            parts = data.split(":")
            job_id = int(parts[1])
            new_delay = int(parts[2])

            await broadcast_manager.job_crud.update_job(job_id, delay_ms=new_delay)
            await event.answer(f"⏱️ تاخیر به {new_delay}ms تغییر کرد", alert=False)
            await _edit_settings_view(event, job_id)

        # Apply batch size selection
        elif data.startswith("broadcast_apply_batch:"):
            parts = data.split(":")
            job_id = int(parts[1])
            new_batch = int(parts[2])

            await broadcast_manager.job_crud.update_job(job_id, batch_size=new_batch)
            await event.answer(f"📦 اندازه دسته به {new_batch} تغییر کرد", alert=False)
            await _edit_settings_view(event, job_id)

        # Apply batch delay selection
        elif data.startswith("broadcast_apply_batch_delay:"):
            parts = data.split(":")
            job_id = int(parts[1])
            new_batch_delay = int(parts[2])

            await broadcast_manager.job_crud.update_job(job_id, batch_delay_ms=new_batch_delay)
            batch_delay_str = texts.format_batch_delay(new_batch_delay)
            await event.answer(f"⏸️ تاخیر بین دسته‌ها به {batch_delay_str} تغییر کرد", alert=False)
            await _edit_settings_view(event, job_id)

        elif data.startswith("broadcast_apply_format:"):
            parts = data.split(":")
            job_id = int(parts[1])
            new_format = parts[2]
            job = await broadcast_manager.job_crud.get_job(job_id)
            if not job:
                await event.answer("❌ کار پیدا نشد!", alert=True)
                return
            payload, error = set_message_type(job.payload_json, new_format)
            if error:
                await event.answer(error, alert=True)
                return
            await broadcast_manager.job_crud.update_job(job_id, payload_json=payload)
            await event.answer(f"📝 نوع پیام: {format_label(payload.get('parse_mode'))}", alert=False)
            await _edit_settings_view(event, job_id)

        # Apply mode selection
        elif data.startswith("broadcast_apply_mode:"):
            parts = data.split(":")
            job_id = int(parts[1])
            new_mode = parts[2]

            await broadcast_manager.job_crud.update_job(job_id, target_mode=new_mode)
            await broadcast_manager.count_targets(job_id)
            await event.answer(
                f"🎯 حالت به {texts.MODE_NAMES_SETTINGS[new_mode]} تغییر کرد",
                alert=False,
            )
            await _edit_settings_view(event, job_id)

        # Create new broadcast from active broadcast screen
        elif data.startswith("broadcast_create_new:"):
            mode = data.split(":")[1]  # "send" or "forward"
            step = states.SEND2ALL_STEP if mode == "send" else states.FORWARD2ALL_STEP
            await set_step(user_id=sender_id, step=step)
            await event.edit(texts.CREATE_NEW_PROMPT_TEXT, buttons=panel_back, parse_mode="md")

        # Show incomplete broadcasts list
        elif data == "broadcast_incomplete_list":
            incomplete_jobs = await broadcast_manager.job_crud.get_incomplete_jobs()

            if not incomplete_jobs:
                await event.answer("✅ هیچ همگانی ناتمامی وجود ندارد!", alert=True)
                return

            mode_names = texts.MODE_NAMES_EMOJI
            status_names = texts.STATUS_NAMES

            list_text = "📋 **همگانی‌های ناتمام:**\n\n"
            buttons = []

            for job in incomplete_jobs:
                mode_name = mode_names.get(job.target_mode, job.target_mode)
                status_name = status_names.get(job.status, job.status)
                sent = job.sent_ok + job.sent_fail + job.blocked + job.deleted
                total = job.total_targets or 0
                progress = (sent / total * 100) if total > 0 else 0

                job_text = f"🆔 {job.id} | {status_name} | {mode_name} | {progress:.1f}%"
                buttons.append([Button.inline(job_text, data=f"broadcast_job_detail:{job.id}")])

            buttons.append([Button.inline("🔙 بازگشت", data="broadcast_menu_back")])

            await event.edit(list_text, buttons=buttons)

        # Show job details
        elif data.startswith("broadcast_job_detail:"):
            job_id = int(data.split(":")[1])
            job = await broadcast_manager.job_crud.get_job(job_id)

            if not job:
                await event.answer("❌ همگانی پیدا نشد!", alert=True)
                return

            await _edit_job_detail_view(event, job)

        # Get broadcast message
        elif data.startswith("broadcast_job_get_msg:"):
            job_id = int(data.split(":")[1])
            job = await broadcast_manager.job_crud.get_job(job_id)

            if not job:
                await event.answer("❌ همگانی پیدا نشد!", alert=True)
                return

            await event.answer("📨 در حال ارسال پیام...", alert=False)

            # Send the broadcast message to admin
            payload = job.payload_json
            is_forward = payload.get("is_forward", False)
            message_ids = payload.get("message_ids", [])
            from_chat = payload.get("from_chat")

            try:
                if message_ids and from_chat:
                    if is_forward:
                        await Kenzo.forward_messages(sender_id, message_ids, from_chat, drop_author=False)
                    else:
                        buttons = deserialize_buttons(payload.get("buttons"))
                        await broadcast_manager.sender._copy_message_with_buttons(
                            sender_id, from_chat, message_ids, buttons
                        )
                elif payload.get("text"):
                    text = payload.get("text", "")
                    buttons = deserialize_buttons(payload.get("buttons"))
                    if payload.get("parse_mode") == "rich":
                        await send_rich_message(sender_id, text, buttons=buttons, rtl=True)
                    else:
                        await Kenzo.send_message(sender_id, text, buttons=buttons)
                else:
                    await event.answer("❌ پیامی یافت نشد!", alert=True)
            except Exception as e:
                logger.error(f"Error sending broadcast message to admin: {e}")
                await event.answer("❌ خطا در ارسال پیام!", alert=True)

        # Resume/Continue broadcast (keep progress)
        elif data.startswith("broadcast_job_resend:"):
            job_id = int(data.split(":")[1])
            job = await broadcast_manager.job_crud.get_job(job_id)

            if not job:
                await safe_answer(event, "❌ همگانی پیدا نشد!", alert=True)
                return

            # Don't reset cursor and counters - continue from where it stopped
            await broadcast_manager.job_crud.update_job(job_id, status="pending_confirm")

            sent = job.sent_ok + job.sent_fail + job.blocked + job.deleted
            remaining = (job.total_targets or 0) - sent

            await safe_answer(event, "✅ همگانی آماده ادامه است!", alert=False)

            # Show confirmation message
            await event.edit(
                f"✅ همگانی #{job_id} آماده ادامه است.\n\n"
                f"📤 ارسال شده: {sent:,}\n"
                f"📥 باقیمانده: {remaining:,}\n\n"
                f"برای ادامه از جایی که متوقف شده، دکمه 'تایید و شروع' را بزنید.",
                buttons=[
                    [Button.inline("✅ تایید و شروع", data=f"broadcast_confirm:{job_id}")],
                    [Button.inline("🔙 بازگشت", data="broadcast_incomplete_list")],
                ],
            )

        # Delete broadcast job
        elif data.startswith("broadcast_job_delete:"):
            job_id = int(data.split(":")[1])
            success = await broadcast_manager.job_crud.delete_job(job_id)

            if success:
                await event.answer("✅ همگانی حذف شد!", alert=False)
                await event.edit(
                    "✅ همگانی با موفقیت حذف شد.",
                    buttons=[[Button.inline("🔙 بازگشت", data="broadcast_incomplete_list")]],
                )
            else:
                await event.answer("❌ خطا در حذف همگانی!", alert=True)

        # Back to menu
        elif data == "broadcast_menu_back":
            await set_step(user_id=sender_id, step=states.PANEL_STEP)
            await event.edit(texts.MENU_BACK_TEXT)

    except Exception as e:
        logger.error(f"Error handling broadcast callback: {e}", exc_info=True)
        await event.answer("❌ خطا در پردازش درخواست!", alert=True)


async def monitor_broadcast_status(message, job_id: int, admin_id: int):
    """Monitor and update broadcast status from queue through completion."""
    seen_running = False
    poll_interval = 0
    monitor_id_saved = False

    try:
        while True:
            status = await broadcast_manager.get_status(job_id)

            if not status:
                break

            job_status = status["status"]

            if job_status in ("queued", "pending_confirm"):
                job = await broadcast_manager.job_crud.get_job(job_id)
                if not job:
                    break

                if job_status == "queued":
                    active_job = await broadcast_manager.job_crud.get_active_job()
                    queue_position = await broadcast_manager.job_crud.get_queue_position(job_id)
                    job_mode = texts.MODE_NAMES_EMOJI.get(job.target_mode, job.target_mode)
                    active_mode = None
                    active_progress = None
                    if active_job:
                        active_status = await broadcast_manager.get_status(active_job.id)
                        active_mode = texts.MODE_NAMES_EMOJI.get(active_job.target_mode, active_job.target_mode)
                        active_progress = active_status.get("progress_percent", 0) if active_status else 0

                    status_text = texts.queue_status_text(
                        job_id=job_id,
                        job_mode=job_mode,
                        job_targets=job.total_targets or 0,
                        queue_position=queue_position,
                        active_mode=active_mode,
                        active_progress=active_progress,
                    )
                else:
                    status_text = texts.STARTING_TEXT

                try:
                    await message.edit(status_text, buttons=None)
                except errors.MessageNotModifiedError:
                    pass
                except Exception as e:
                    logger.error(f"Error updating queued broadcast message: {e}")

            elif job_status in ["done", "canceled", "failed"]:
                final_text = texts.final_status_text(status)
                try:
                    await message.edit(final_text, buttons=None)
                except Exception as e:
                    logger.error(f"Error editing final broadcast message: {e}")
                if job_status == "done":
                    try:
                        await broadcast_manager.job_crud.delete_job(job_id)
                        logger.info(f"Broadcast job {job_id} deleted after showing final message")
                    except Exception as e:
                        logger.error(f"Error deleting completed broadcast job {job_id}: {e}")
                break

            else:
                just_started = job_status == "running" and not seen_running
                if job_status == "running":
                    seen_running = True

                status_text = texts.running_status_text(status, just_started=just_started)
                buttons = keyboards.monitor_status_buttons(job_id, paused=job_status == "paused")

                try:
                    await message.edit(status_text, buttons=buttons)
                except errors.MessageNotModifiedError:
                    pass
                except Exception as e:
                    logger.error(f"Error updating status message: {e}")

            if not monitor_id_saved:
                await _persist_monitor_message_id(job_id, message.id)
                monitor_id_saved = True

            poll_interval = BROADCAST_MONITOR_POLL_SECONDS
            await asyncio.sleep(poll_interval)

    except Exception as e:
        logger.error(f"Error in status monitor: {e}")


def callback_filter(event):
    """Filter for broadcast callback queries."""
    if not event.is_private:
        return False
    data = event.data.decode() if isinstance(event.data, bytes) else event.data
    return data.startswith("broadcast_")


def register(client):
    client.add_event_handler(callback_handler, events.CallbackQuery(func=callback_filter))
