"""Package entry point for admin manage_user."""

from app.telegram.admin.manage_user import callbacks, messages

MODULE_NAME = "admin.manage_user"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "Admin user management flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
