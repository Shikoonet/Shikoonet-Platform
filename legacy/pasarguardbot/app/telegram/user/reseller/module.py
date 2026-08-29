"""Package entry point for user reseller purchase flow."""

from app.telegram.user.reseller import callbacks, messages

MODULE_NAME = "user.reseller"
MODULE_ENABLED = True
MODULE_ORDER = 1010
MODULE_DESCRIPTION = "user reseller purchase and account management"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
