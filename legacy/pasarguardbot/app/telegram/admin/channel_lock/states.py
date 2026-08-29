"""State constants for admin channel_lock."""

CHANNEL_LOCK_MENU_PATTERN = r"^🔐 قفل چنل ها$"

PANEL_STEP = "panel"
LOCK_ADD_CHANNEL_STEP = "lock_add_channel"
LOCK_EDIT_LINK_STEP = "lock_edit_link"
LOCK_EDIT_TITLE_STEP = "lock_edit_title"

LEGACY_ADD_CHANNEL_STEP = "add_channel"
LEGACY_WAITING_FOR_LINK_STEP = "waiting_for_link"
LEGACY_WAITING_FOR_TITLE_STEP = "waiting_for_title"
LEGACY_EDIT_CHANNEL_TITLE_STEP = "edit_channel_title"
LEGACY_EDIT_CHANNEL_LINK_STEP = "edit_channel_link"

LEGACY_CHANNEL_LOCK_STEPS = frozenset(
    {
        LEGACY_ADD_CHANNEL_STEP,
        LEGACY_WAITING_FOR_LINK_STEP,
        LEGACY_WAITING_FOR_TITLE_STEP,
        LEGACY_EDIT_CHANNEL_TITLE_STEP,
        LEGACY_EDIT_CHANNEL_LINK_STEP,
    }
)

LEGACY_ADD_CHANNEL_MESSAGE = "افزودن کانال"

LOCK_EDIT_CHANNEL_ID_KEY = "lock_edit_channel_id"
LEGACY_WAITING_FOR_ID_KEY = "waiting_for_id"
LEGACY_WAITING_FOR_LINK_KEY = "waiting_for_link"
LEGACY_WAITING_FOR_TITLE_KEY = "waiting_for_title"
LEGACY_CHANNEL_EDIT_ID_KEY = "channel_edit_id"
LEGACY_CHANNEL_NEW_TITLE_KEY = "channel_new_title"

LOCK_CHANNELS_BACK = "lock_channels_back"
LOCK_CHANNELS_LIST = "lock_channels_list"
LOCK_CHANNELS_BACK_TO_MENU = "lock_channels_back_to_menu"
LOCK_CHANNELS_BACK_TO_LIST = "lock_channels_back_to_list"
LOCK_CHANNELS_ADD = "lock_channels_add"
LOCK_CHANNELS_VIEW_PREFIX = "lock_channels_view:"
LOCK_CHANNELS_EDIT_LINK_PREFIX = "lock_channels_edit_link:"
LOCK_CHANNELS_EDIT_TITLE_PREFIX = "lock_channels_edit_title:"
LOCK_CHANNELS_DELETE_PREFIX = "lock_channels_delete:"
LOCK_CHANNELS_CONFIRM_DELETE_PREFIX = "lock_channels_confirm_delete:"
