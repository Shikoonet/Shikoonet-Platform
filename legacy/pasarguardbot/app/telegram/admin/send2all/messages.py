"""Message handlers for admin send2all."""

import asyncio

from telethon import events
from telethon.tl.custom import Message

from app.logger import get_logger
from app.services.broadcast.manager import broadcast_manager
from app.services.broadcast.markup import sanitize_payload_json, serialize_message_buttons
from app.services.broadcast.payload_format import format_label, is_text_only_payload
from app.services.telegram.message_media import message_has_file_media
from app.telegram.admin.send2all import keyboards, states, texts
from app.telegram.state import get_step, set_step
from config import ADMIN_ID

logger = get_logger(__name__)

album_buffer = {}
album_ready = {}
album_processed = {}


async def _show_broadcast_entry_menu(event: Message, *, create_mode: str, menu_title: str, in_progress_label: str):
    """Show broadcast menu or active-job summary for send/forward entry points."""
    active_job = await broadcast_manager.job_crud.get_active_job()
    if active_job:
        status = await broadcast_manager.get_status(active_job.id)
        if status and status["status"] == "running":
            mode_name = texts.MODE_NAMES_EMOJI.get(active_job.target_mode, active_job.target_mode)
            progress = status.get("progress_percent", 0)
            sent = (
                status.get("sent_ok", 0)
                + status.get("sent_fail", 0)
                + status.get("blocked", 0)
                + status.get("deleted", 0)
            )
            total = status.get("total_targets", 0)
            queue_count = await broadcast_manager.job_crud.count_queued_jobs()
            admin_mention = f"<a href='tg://user?id={active_job.created_by}'>ادمین</a>"
            info_text = texts.active_broadcast_info_text(
                admin_mention=admin_mention,
                mode_name=mode_name,
                progress=progress,
                sent=sent,
                total=total,
                sent_ok=status.get("sent_ok", 0),
                sent_fail=status.get("sent_fail", 0),
                queue_count=queue_count,
                broadcast_label=in_progress_label,
            )
            await event.respond(
                info_text,
                parse_mode="html",
                buttons=keyboards.active_broadcast_buttons(create_mode=create_mode),
            )
            return

    incomplete_count = len(await broadcast_manager.job_crud.get_incomplete_jobs())
    await event.respond(
        texts.broadcast_menu_text(menu_title),
        buttons=keyboards.broadcast_menu_buttons(incomplete_count=incomplete_count, create_mode=create_mode),
    )


async def collect_album(event: Message):
    """Collect album messages - wait for all messages in album to arrive"""
    if not event.is_private:
        return

    if not event.grouped_id:
        return

    sender_id = event.sender_id
    if sender_id not in ADMIN_ID:
        return

    step = await get_step(sender_id)
    if step not in states.ALBUM_COLLECT_STEPS:
        return

    grouped_id = event.grouped_id

    # Initialize buffer for this album if not exists
    if grouped_id not in album_buffer:
        album_buffer[grouped_id] = []
        album_ready[grouped_id] = False
        album_processed[grouped_id] = False

    # Skip if already processed
    if album_processed.get(grouped_id, False):
        return

    # Add this message to buffer
    album_buffer[grouped_id].append(event)

    # Wait a bit for other messages in album to arrive
    await asyncio.sleep(2)

    # Sort by message ID to maintain order
    album_buffer[grouped_id].sort(key=lambda e: e.message.id)

    # Mark as ready after collecting
    if not album_ready[grouped_id]:
        album_ready[grouped_id] = True
        logger.info(f"Album {grouped_id} collected with {len(album_buffer[grouped_id])} messages.")


async def message_handler_send_toall(event: Message):
    """Main message handler for broadcast functionality"""
    if not event.is_private:
        return

    sender_id = event.sender_id
    msg = event.message

    if sender_id not in ADMIN_ID:
        return

    current_step = await get_step(sender_id)

    if msg.text == states.SEND_BROADCAST_MESSAGE:
        if current_step == states.SENDING_IN_PROGRESS_STEP:
            await event.respond(texts.SEND_IN_PROGRESS_TEXT)
            return
        await _show_broadcast_entry_menu(
            event,
            create_mode="send",
            menu_title="📮 **ارسال همگانی**",
            in_progress_label="ارسال همگانی",
        )
        return

    if msg.text == states.FORWARD_BROADCAST_MESSAGE:
        if current_step == states.SENDING_IN_PROGRESS_STEP:
            await event.respond(texts.FORWARD_IN_PROGRESS_TEXT)
            return
        await _show_broadcast_entry_menu(
            event,
            create_mode="forward",
            menu_title="📥 **فوروارد همگانی**",
            in_progress_label="فوروارد همگانی",
        )
        return
    # Handle cancel/back button
    if msg.text == states.BACK_TO_PANEL_MESSAGE and current_step in states.CANCEL_BACK_STEPS:
        await set_step(user_id=sender_id, step=states.PANEL_STEP)
        await event.respond(texts.CANCELLED_TO_PANEL_TEXT)
        return

    # Handle message collection and job creation
    if current_step in states.ALBUM_COLLECT_STEPS and msg.text != "🔙 بازگشت به پنل":
        is_forward = current_step == states.FORWARD2ALL_STEP

        # Check if this is part of an album
        if msg.grouped_id:
            grouped_id = msg.grouped_id

            # Wait for album to be fully collected (max 10 seconds)
            max_wait = 10
            waited = 0
            while grouped_id not in album_ready or not album_ready[grouped_id]:
                await asyncio.sleep(0.5)
                waited += 0.5
                if waited >= max_wait:
                    logger.warning(f"Timeout waiting for album {grouped_id}")
                    break

            # Check if album is ready
            if grouped_id not in album_buffer or not album_ready.get(grouped_id, False):
                await event.respond(texts.ALBUM_COLLECT_ERROR_TEXT)
                return

            # Check if album was already processed
            if album_processed.get(grouped_id, False):
                logger.debug(f"Album {grouped_id} already processed, skipping")
                return

            # Get all messages in album
            album_events = album_buffer[grouped_id]

            # Only process if this is the first message in album (to avoid duplicate jobs)
            if album_events and event.message.id != album_events[0].message.id:
                # This is not the first message, skip job creation
                logger.debug(f"Skipping job creation for album message {event.message.id}, waiting for first message")
                return

            # Mark as processed immediately to prevent duplicate jobs
            album_processed[grouped_id] = True

            # Prepare payload for album
            message_ids = [e.message.id for e in album_events]
            from_chat = event.chat_id

            payload = {
                "is_forward": is_forward,
                "message_ids": message_ids,
                "from_chat": from_chat,
                "keep_author": is_forward,
            }

            # Clean up album buffer after using it
            del album_buffer[grouped_id]
            del album_ready[grouped_id]
            del album_processed[grouped_id]

            logger.info(f"Album with {len(message_ids)} messages ready for {'forward' if is_forward else 'send'}.")
        else:
            # Single message (not album)
            serialized_buttons = serialize_message_buttons(msg)
            text = msg.text or msg.message or ""

            if not is_forward and text and not message_has_file_media(msg):
                payload = {
                    "is_forward": False,
                    "keep_author": False,
                    "text": text,
                }
                if serialized_buttons:
                    payload["buttons"] = serialized_buttons
            else:
                message_ids = [msg.id]
                from_chat = event.chat_id
                payload = {
                    "is_forward": is_forward,
                    "message_ids": message_ids,
                    "from_chat": from_chat,
                    "keep_author": is_forward,
                }
                if text:
                    payload["text"] = text
                if serialized_buttons:
                    payload["buttons"] = serialized_buttons

        payload = sanitize_payload_json(payload)

        # Create draft job
        job_id = await broadcast_manager.create_job(
            created_by=sender_id,
            target_mode="active",  # Default: only active users
            payload_json=payload,
            delay_ms=0,
            batch_size=10,
            batch_delay_ms=2000,  # 2 seconds delay between batches
        )

        if not job_id:
            await event.respond(texts.JOB_CREATE_ERROR_TEXT)
            await set_step(user_id=sender_id, step=states.PANEL_STEP)
            return

        # Count targets
        target_count = await broadcast_manager.count_targets(job_id)

        if target_count == 0:
            await event.respond(texts.NO_TARGETS_TEXT)
            await set_step(user_id=sender_id, step=states.PANEL_STEP)
            return

        # Update job to pending_confirm
        await broadcast_manager.job_crud.update_job(job_id, status="pending_confirm")

        # Get job from database to show accurate values
        job = await broadcast_manager.job_crud.get_job(job_id)
        if not job:
            await event.respond(texts.JOB_FETCH_ERROR_TEXT)
            await set_step(user_id=sender_id, step=states.PANEL_STEP)
            return

        # Show preview and confirmation
        await set_step(user_id=sender_id, step=states.BROADCAST_CONFIRM_STEP)

        mode_name = texts.MODE_NAMES_PLAIN.get(job.target_mode, job.target_mode)
        batch_delay_str = texts.format_batch_delay(job.batch_delay_ms)
        estimated_seconds = texts.calculate_estimated_time(
            target_count, job.delay_ms, job.batch_size, job.batch_delay_ms
        )
        estimated_time_str = texts.format_duration(estimated_seconds)

        preview_format = None
        if is_text_only_payload(job.payload_json) or job.payload_json.get("parse_mode"):
            preview_format = format_label(job.payload_json.get("parse_mode"))

        await event.respond(
            texts.preview_text(
                is_forward=is_forward,
                target_count=target_count,
                mode_name=mode_name,
                delay_ms=job.delay_ms,
                batch_size=job.batch_size,
                batch_delay_str=batch_delay_str,
                estimated_time_str=estimated_time_str,
                format_name=preview_format,
            ),
            buttons=keyboards.confirm_buttons(job_id),
        )
        # Clean up album buffer
        if msg.grouped_id and msg.grouped_id in album_buffer:
            del album_buffer[msg.grouped_id]
            if msg.grouped_id in album_ready:
                del album_ready[msg.grouped_id]

    # Handle settings step
    if current_step == states.BROADCAST_SETTINGS_STEP:
        # Parse settings from message (format: "delay:300 batch:50 mode:all")
        # This is a simplified version - you can enhance it
        await event.respond(texts.SETTINGS_USE_BUTTONS_TEXT)
        return


def album_filter(event):
    """Filter for album messages."""
    gid = event.grouped_id
    return gid is not None and isinstance(gid, int)


async def send_to_all_filter(event):
    """Filter for executing handler only for admin and specific steps."""
    sender_id = event.sender_id
    step = await get_step(sender_id)
    return sender_id in ADMIN_ID and step in states.SEND_TO_ALL_FILTER_STEPS


def register(client):
    client.add_event_handler(collect_album, events.NewMessage(incoming=True, func=album_filter, from_users=ADMIN_ID))
    client.add_event_handler(
        message_handler_send_toall, events.NewMessage(incoming=True, func=send_to_all_filter, from_users=ADMIN_ID)
    )
