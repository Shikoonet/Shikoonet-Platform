from __future__ import annotations

import random
import string


def generate_username(length: int = 9) -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=length))
