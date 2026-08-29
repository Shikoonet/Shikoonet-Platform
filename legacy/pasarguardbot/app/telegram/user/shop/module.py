"""Package entry point for user shop purchase flow."""

from app.telegram.user.shop import callbacks, messages

MODULE_NAME = "user.shop"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "user shop purchase flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
