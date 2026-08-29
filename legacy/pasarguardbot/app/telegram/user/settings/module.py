"""Package entry point for the user settings module."""

from app.telegram.user.settings import callbacks, messages

MODULE_NAME = "user.settings"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "User advanced display settings"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
