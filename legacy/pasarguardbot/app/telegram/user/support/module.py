"""Package entry point for the user support module."""

from app.telegram.user.support import messages

MODULE_NAME = "user.support"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "User support messaging flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    _registered_clients.add(client_id)
