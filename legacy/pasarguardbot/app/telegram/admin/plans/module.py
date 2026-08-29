"""Package entry point for the admin plans module."""

from app.telegram.admin.plans import callbacks, messages

MODULE_NAME = "admin.plans"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "Admin plan management flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
