"""Package entry point for the admin ping module."""

from app.telegram.admin.ping import messages

MODULE_NAME = "admin.ping"
MODULE_ENABLED = True
MODULE_ORDER = 10
MODULE_DESCRIPTION = "Admin ping command"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    _registered_clients.add(client_id)
