"""Package entry point for shared user navigation callbacks."""

from app.telegram.user.navigation import callbacks

MODULE_NAME = "user.navigation"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "Shared user navigation callbacks (cancel-to-home, no-op buttons)"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    callbacks.register(client)
    _registered_clients.add(client_id)
