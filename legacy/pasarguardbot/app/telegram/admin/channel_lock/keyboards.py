"""Keyboard builders for admin channel_lock."""

from app.telegram.admin.channel_lock import states
from app.telegram.keyboards.common import glass_inline_button, glass_url_button


def main_menu_buttons():
    return [
        [
            glass_inline_button("لیست کانال", data=states.LOCK_CHANNELS_LIST),
            glass_inline_button("افزودن کانال", data=states.LOCK_CHANNELS_ADD),
        ],
        [glass_inline_button("بازگشت", data=states.LOCK_CHANNELS_BACK)],
    ]


def back_to_menu_button():
    return [[glass_inline_button("بازگشت", data=states.LOCK_CHANNELS_BACK_TO_MENU)]]


def channel_list_buttons(channels):
    buttons = []
    for channel in channels:
        title = channel.get("title", f"کانال {channel.get('id')}")
        if len(title) > 30:
            title = title[:27] + "..."
        buttons.append(
            [glass_inline_button(f"📢 {title}", data=f"{states.LOCK_CHANNELS_VIEW_PREFIX}{channel.get('id')}")]
        )
    buttons.append([glass_inline_button("بازگشت", data=states.LOCK_CHANNELS_BACK_TO_MENU)])
    return buttons


def channel_detail_buttons(channel_info: dict):
    channel_id = channel_info["id"]
    return [
        [glass_url_button("🔓 باز کردن کانال", url=channel_info["link"])],
        [
            glass_inline_button("✏️ تغییر لینک", data=f"{states.LOCK_CHANNELS_EDIT_LINK_PREFIX}{channel_id}"),
            glass_inline_button("📝 تغییر عنوان", data=f"{states.LOCK_CHANNELS_EDIT_TITLE_PREFIX}{channel_id}"),
        ],
        [glass_inline_button("🗑 حذف کانال", data=f"{states.LOCK_CHANNELS_DELETE_PREFIX}{channel_id}")],
        [glass_inline_button("🔙 بازگشت به لیست", data=states.LOCK_CHANNELS_BACK_TO_LIST)],
        [glass_inline_button("🔙 بازگشت به منوی اصلی", data=states.LOCK_CHANNELS_BACK_TO_MENU)],
    ]


def edit_link_back_button(channel_id):
    return [[glass_inline_button("🔙 بازگشت", data=f"{states.LOCK_CHANNELS_VIEW_PREFIX}{channel_id}")]]


def edit_title_back_button(channel_id):
    return [[glass_inline_button("🔙 بازگشت", data=f"{states.LOCK_CHANNELS_VIEW_PREFIX}{channel_id}")]]


def delete_confirm_buttons(channel_id):
    return [
        [glass_inline_button("✅ بله، حذف کن", data=f"{states.LOCK_CHANNELS_CONFIRM_DELETE_PREFIX}{channel_id}")],
        [glass_inline_button("❌ خیر، بازگشت", data=f"{states.LOCK_CHANNELS_VIEW_PREFIX}{channel_id}")],
    ]


def add_channel_back_button():
    return [[glass_inline_button("🔙 بازگشت", data=states.LOCK_CHANNELS_BACK_TO_MENU)]]
