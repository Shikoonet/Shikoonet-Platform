"""State constants for admin help download management."""

HELP_DOWNLOAD_APP_CONFIG_APP_ID = "help_download_app_config_app_id"
HELP_DL_TGT_APP_ID = "help_dl_tgt_app_id"
HELP_DL_TGT_TARGET_ID = "help_dl_tgt_target_id"
HELP_DL_TGT_ADD_BUTTON_TEXT = "help_dl_tgt_add_button_text"

HELP_DOWNLOAD_APP_ADD_BUTTON_TEXT = "HelpDownloadAppAddButtonText"
HELP_DOWNLOAD_APP_ADD_REPO_OWNER = "HelpDownloadAppAddRepoOwner"
HELP_DOWNLOAD_APP_ADD_REPO_NAME = "HelpDownloadAppAddRepoName"
HELP_DOWNLOAD_APP_ADD_CATEGORIES = "HelpDownloadAppAddCategories"
HELP_DOWNLOAD_APP_ADD_TEXT_BUTTON_TEXT = "HelpDownloadAppAddTextButtonText"

HELP_DOWNLOAD_APP_CONFIG_SET_ICON = "help_download_app_config_set_icon"
HELP_DOWNLOAD_APP_CONFIG_EDIT_TEXT = "help_download_app_config_edit_text"
HELP_DOWNLOAD_APP_CONFIG_REPO = "help_download_app_config_repo"
HELP_DOWNLOAD_APP_CONFIG_IOS = "help_download_app_config_ios"
HELP_DOWNLOAD_APP_CONFIG_CUSTOM_MSG = "help_download_app_config_custom_msg"

HELP_DL_TGT_ADD_TEXT = "help_dl_tgt_add_text"
HELP_DL_TGT_ADD_PATTERNS = "help_dl_tgt_add_patterns"
HELP_DL_TGT_EDIT_TEXT = "help_dl_tgt_edit_text"
HELP_DL_TGT_EDIT_PATTERNS = "help_dl_tgt_edit_patterns"
HELP_DL_TGT_SET_ICON = "help_dl_tgt_set_icon"

HELP_DOWNLOAD_APP_ADD_TEXT1 = "HelpDownloadAppAddText1"
HELP_DOWNLOAD_APP_ADD_TEXT2 = "HelpDownloadAppAddText2"
HELP_DOWNLOAD_APP_ADD1 = "HelpDownloadAppAdd1"
HELP_DOWNLOAD_APP_ADD2 = "HelpDownloadAppAdd2"
HELP_DOWNLOAD_APP_ADD3 = "HelpDownloadAppAdd3"
HELP_DOWNLOAD_APP_ADD4 = "HelpDownloadAppAdd4"

HELP_DOWNLOAD_ADMIN_STEPS = frozenset(
    {
        HELP_DOWNLOAD_APP_CONFIG_SET_ICON,
        HELP_DOWNLOAD_APP_CONFIG_EDIT_TEXT,
        HELP_DOWNLOAD_APP_CONFIG_REPO,
        HELP_DOWNLOAD_APP_CONFIG_IOS,
        HELP_DOWNLOAD_APP_CONFIG_CUSTOM_MSG,
        HELP_DL_TGT_ADD_TEXT,
        HELP_DL_TGT_ADD_PATTERNS,
        HELP_DL_TGT_EDIT_TEXT,
        HELP_DL_TGT_EDIT_PATTERNS,
        HELP_DL_TGT_SET_ICON,
        HELP_DOWNLOAD_APP_ADD_TEXT1,
        HELP_DOWNLOAD_APP_ADD_TEXT2,
        HELP_DOWNLOAD_APP_ADD1,
        HELP_DOWNLOAD_APP_ADD2,
        HELP_DOWNLOAD_APP_ADD4,
    }
)

CANCEL_STEP_KEYS = (
    HELP_DOWNLOAD_APP_ADD_BUTTON_TEXT,
    HELP_DOWNLOAD_APP_ADD_REPO_OWNER,
    HELP_DOWNLOAD_APP_ADD_REPO_NAME,
    HELP_DOWNLOAD_APP_ADD_CATEGORIES,
    HELP_DOWNLOAD_APP_ADD_TEXT_BUTTON_TEXT,
    HELP_DOWNLOAD_APP_CONFIG_APP_ID,
)

IOS_SKIP_STEP_KEYS = (
    HELP_DOWNLOAD_APP_ADD_BUTTON_TEXT,
    HELP_DOWNLOAD_APP_ADD_REPO_OWNER,
    HELP_DOWNLOAD_APP_ADD_REPO_NAME,
    HELP_DOWNLOAD_APP_ADD_CATEGORIES,
    HELP_DOWNLOAD_APP_ADD_TEXT_BUTTON_TEXT,
)

ADD_FLOW_STEP_KEYS = (
    HELP_DOWNLOAD_APP_ADD_BUTTON_TEXT,
    HELP_DOWNLOAD_APP_ADD_REPO_OWNER,
    HELP_DOWNLOAD_APP_ADD_REPO_NAME,
    HELP_DOWNLOAD_APP_ADD_CATEGORIES,
)

DEFAULT_CATEGORIES = {
    "📱 **اندروید**": ["arm64", "arm7", "x86_64", "apk", "Android"],
    "💻 **ویندوز**": ["zip", "exe", "msix", "Windows"],
    "🐧 **لینوکس**": ["AppImage", "deb", "rpm", "Linux"],
    "🍎 **مک**": ["dmg", "pkg", "MacOS", "Mac"],
    "Universal": ["universal"],
}

ANDROID_ONLY_CATEGORIES = {
    "📱 **اندروید**": ["arm64", "arm7", "apk", "Android", ".apk"],
}
