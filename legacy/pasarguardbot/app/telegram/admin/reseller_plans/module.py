"""Package entry point for admin reseller plans module."""

from app.telegram.admin.reseller_plans import callbacks, messages

MODULE_NAME = "admin.reseller_plans"
MODULE_ENABLED = True
MODULE_ORDER = 1010
MODULE_DESCRIPTION = "Admin reseller plan management"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
