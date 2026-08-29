"""Package entry point for the user trial module."""

from app.telegram.user.trial import messages

MODULE_NAME = "user.trial"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "User free trial flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    _registered_clients.add(client_id)
