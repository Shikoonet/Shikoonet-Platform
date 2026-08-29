from __future__ import annotations

from app.services.panels.settings import panel_node_prefixes, panel_show_prefixes_in_locations


def format_node_name_for_display(node_name, panel):
    """Format node names for display, optionally stripping panel prefixes."""
    if panel_show_prefixes_in_locations(panel):
        return node_name

    panel_prefixes = panel_node_prefixes(panel)
    formatted_name = node_name
    for prefix in panel_prefixes:
        if formatted_name.startswith(prefix):
            formatted_name = formatted_name[len(prefix) :].strip()
            break

    return formatted_name


def filter_nodes_by_plan_type(nodes, plan, panel):
    """Filter panel nodes based on plan type and prefixes configured on the panel."""
    if not nodes:
        return []

    panel_prefixes = panel_node_prefixes(panel)

    if not panel_prefixes:
        return nodes

    plan_type = getattr(plan, "plan_type", "volume")
    data_limit_reset_strategy = getattr(plan, "data_limit_reset_strategy", "no_reset")

    if plan_type == "unlimited_volume" or (plan_type == "volume" and data_limit_reset_strategy != "no_reset"):
        allowed_prefixes = ["UL -", "HYB -"]
    else:
        allowed_prefixes = ["LT -", "HYB -"]

    default_prefixes = ["LT -", "HYB -", "UL -"]
    custom_prefixes = [p for p in panel_prefixes if p not in default_prefixes]
    allowed_prefixes.extend(custom_prefixes)

    filtered_nodes = []
    for node in nodes:
        node_name = getattr(node, "name", "") or ""
        for prefix in allowed_prefixes:
            if node_name.startswith(prefix) and prefix in panel_prefixes:
                filtered_nodes.append(node)
                break

    return filtered_nodes
