"""Package entry point for the admin channel_lock module."""

from app.telegram.admin.channel_lock import callbacks, messages

MODULE_NAME = "admin.channel_lock"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "Admin channel lock flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
