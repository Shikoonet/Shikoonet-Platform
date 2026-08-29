"""Package entry point for the admin send2all module."""

from app.telegram.admin.send2all import callbacks, messages

MODULE_NAME = "admin.send2all"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "Admin broadcast flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
