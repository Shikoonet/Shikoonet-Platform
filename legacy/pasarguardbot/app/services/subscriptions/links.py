"""Subscription URL building and display helpers shared by message/callback handlers."""

from __future__ import annotations

from urllib.parse import urlparse

from app.services.panels.settings import panel_subscription_link_mode


def build_tunnel_subscription_url(subscription_url: str, tunnel_base_url: str | None) -> str | None:
    if not tunnel_base_url:
        return None

    if subscription_url.startswith("http"):
        parsed = urlparse(subscription_url)
        subscription_path = parsed.path or "/"
        if parsed.query:
            subscription_path = f"{subscription_path}?{parsed.query}"
    else:
        subscription_path = subscription_url if subscription_url.startswith("/") else f"/{subscription_url}"

    return f"{tunnel_base_url.rstrip('/')}{subscription_path}"


def resolve_subscription_link_mode(panel) -> str:
    return panel_subscription_link_mode(panel)


def resolve_subscription_display_urls(panel, subscription_url: str, tunnel_subscription_url: str | None):
    mode = resolve_subscription_link_mode(panel)
    if mode == "tunnel" and tunnel_subscription_url:
        return tunnel_subscription_url, "", tunnel_subscription_url
    if mode == "main":
        return subscription_url, "", subscription_url

    tunnel_url_text = ""
    if tunnel_subscription_url:
        tunnel_url_text = f"\n**🌐 لینک تانل:**\n`{tunnel_subscription_url}`"
    return subscription_url, tunnel_url_text, subscription_url


def format_subscription_links_for_message(
    panel,
    subscription_url: str,
    main_label: str = "🔗 لینک اصلی",
    tunnel_label: str = "🌐 لینک تانل",
) -> tuple[str, str]:
    tunnel_subscription_url = build_tunnel_subscription_url(subscription_url, getattr(panel, "tunnel_url", None))
    mode = resolve_subscription_link_mode(panel)

    if mode == "tunnel" and tunnel_subscription_url:
        return f"{tunnel_label}:\n`{tunnel_subscription_url}`", tunnel_subscription_url

    if mode == "main" or not tunnel_subscription_url:
        return f"{main_label}:\n`{subscription_url}`", subscription_url

    links_text = f"{main_label}:\n`{subscription_url}`\n\n{tunnel_label}:\n`{tunnel_subscription_url}`"
    return links_text, subscription_url
