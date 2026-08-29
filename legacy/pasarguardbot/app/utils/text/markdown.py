# Markdown formatter for Aiogram (custom)
# compatible with Bot API Markdown


def bold(text: str) -> str:
    return f"**{text}**"


def italic(text: str) -> str:
    return f"_{text}_"


def code(text: str) -> str:
    return f"`{text}`"


def pre(text: str) -> str:
    return f"```{text}```"


def link(label: str, url: str) -> str:
    return f"[{label}]({url})"


def escape(text: str) -> str:
    return text.replace("_", "\\_").replace("*", "\\*").replace("`", "\\`")


def spoiler(text: str) -> str:
    return f"^sp^{text}^sp^"


def quote(text: str, collapsed: bool = False) -> str:
    return f"^qc^{text}^qc^" if collapsed else f"^q^{text}^q^"
