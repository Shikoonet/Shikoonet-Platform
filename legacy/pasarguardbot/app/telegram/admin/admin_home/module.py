"""Package entry point for the admin home panel module."""

from app.telegram.admin.admin_home import callbacks, messages

MODULE_NAME = "admin.admin_home"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "Admin home panel shell"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
