"""The agentorg home: the directory holding the database and the token.

It is `AGENTORG_HOME`, or `~/.local/share/agentorg/`. Backing up means copying it.
"""

import os
import secrets
import stat
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


def token_path() -> Path:
    return home() / "token"


def read_token() -> str:
    """The bearer token: `AGENTORG_TOKEN` when set, else the token file."""
    configured = os.environ.get("AGENTORG_TOKEN")
    if configured:
        return configured
    path = token_path()
    if not path.exists():
        raise FileNotFoundError(f"there is no token at {path}; start agentorg serve first")
    return _read_private(path)


def ensure_token() -> str:
    """The token in the token file, created with mode 600 when there is none."""
    path = token_path()
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, "w") as file:
            file.write(secrets.token_urlsafe(32) + "\n")
    return _read_private(path)


def _read_private(path: Path) -> str:
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise PermissionError(f"{path} is readable by other users; run chmod 600 {path}")
    return path.read_text().strip()
