"""Helper utilities for free trial flow."""

from __future__ import annotations

from app.db.crud.user import UserCRUD
from app.services.panels.auth import PanelGroupsResponse
from app.services.panels.settings import panel_default_group_ids

BOT_LANGUAGE = "fa"


def _resolve_panel_group_ids(panel, groups_resp: PanelGroupsResponse) -> list[int]:
    selected_ids = sorted(
        {gid for gid in panel_default_group_ids(panel) if any(g.id == gid for g in groups_resp.groups)}
    )
    if selected_ids:
        return selected_ids
    return [g.id for g in groups_resp.groups]


async def _user_lang(user_id: int) -> str:
    info = await UserCRUD().read_user(user_id)
    return info.language if info and info.language else BOT_LANGUAGE
