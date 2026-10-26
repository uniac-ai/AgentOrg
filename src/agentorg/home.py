"""The agentorg home: the directory holding the database and the token.

It is `AGENTORG_HOME`, or `~/.local/share/agentorg/`. Backing up means copying it.
"""

import os
from pathlib import Path


def home() -> Path:
    configured = os.environ.get("AGENTORG_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".local/share/agentorg"


def ensure_home() -> Path:
    """The home directory, created readable by its owner only when it does not exist."""
    path = home()
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def database_path() -> Path:
    return home() / "agentorg.db"
