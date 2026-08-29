"""Package entry point for the admin bulk_increase module."""

from app.telegram.admin.bulk_increase import callbacks, messages

MODULE_NAME = "admin.bulk_increase"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "Admin bulk increase flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
