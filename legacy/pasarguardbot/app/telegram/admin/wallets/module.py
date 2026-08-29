"""Package entry point for the admin wallets module."""

from app.telegram.admin.wallets import callbacks, messages

MODULE_NAME = "admin.wallets"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "Admin wallet flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
