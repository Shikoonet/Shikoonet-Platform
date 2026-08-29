"""Package entry point for the admin backup module."""

from app.telegram.admin.backup import callbacks, messages

MODULE_NAME = "admin.backup"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "Admin database/.env backup flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
