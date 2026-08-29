"""Package entry point for admin stats/info bot."""

from app.telegram.admin.info_bot import callbacks, messages

MODULE_NAME = "admin.info_bot"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "Admin stats and info bot panel"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
