"""Package entry point for the user help module."""

from app.telegram.user.help import callbacks, messages

MODULE_NAME = "user.help"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "User help menu and app download callbacks"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
