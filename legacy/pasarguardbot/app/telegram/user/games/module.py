"""Package entry point for user games."""

from app.telegram.user.games import callbacks, messages

MODULE_NAME = "user.games"
MODULE_ENABLED = True
MODULE_ORDER = 1000
MODULE_DESCRIPTION = "User games and rewards"

_registered_clients: set[int] = set()


def setup(client):
    client_id = id(client)
    if client_id in _registered_clients:
        return
    messages.register(client)
    callbacks.register(client)
    _registered_clients.add(client_id)
