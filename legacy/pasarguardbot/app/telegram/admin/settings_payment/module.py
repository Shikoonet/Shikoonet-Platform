"""Package entry point for the admin settings_payment module."""

from app.telegram.admin.settings_payment import callbacks, messages

MODULE_NAME = "admin.settings_payment"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "Admin payment settings flow"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
