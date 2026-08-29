"""Package entry point for user service management flow."""

from app.telegram.user.services import callbacks, messages

MODULE_NAME = "user.services"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "user service management flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
