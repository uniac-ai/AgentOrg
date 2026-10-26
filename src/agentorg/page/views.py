"""The decisions page's HTML: Jinja2 templates with autoescaping, and the stylesheet inline.

The Content-Security-Policy admits that one stylesheet by its hash and nothing else to load or
run, so text an agent wrote cannot become script even if it slipped past escaping.
"""

import base64
import hashlib
from datetime import UTC, datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined

from agentorg.models.common import WORDS_MAX
from agentorg.page.model import Page, count

HERE = Path(__file__).parent
STYLESHEET = (HERE / "page.css").read_text()
_STYLESHEET_HASH = base64.b64encode(hashlib.sha256(STYLESHEET.encode()).digest()).decode()

HEADERS = {
    "Content-Security-Policy": "; ".join(
        [
            "default-src 'none'",
            f"style-src 'sha256-{_STYLESHEET_HASH}'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "base-uri 'none'",
        ]
    ),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}


def ago(moment: datetime, now: datetime | None = None) -> str:
    """How long ago, roughly: "just now", "12 min ago", "5 h ago", "3 days ago"."""
    minutes = int(((now or datetime.now(UTC)) - moment).total_seconds() // 60)
    if minutes < 1:
        return "just now"
    if minutes < 60:
        return f"{minutes} min ago"
    if minutes < 48 * 60:
        return f"{minutes // 60} h ago"
    return f"{minutes // (24 * 60)} days ago"


def local(moment: datetime) -> str:
    """The moment in the service's local time, which is the user's on one machine."""
    return moment.astimezone().strftime("%Y-%m-%d %H:%M")


_templates = Environment(
    loader=FileSystemLoader(HERE / "templates"),
    autoescape=True,
    undefined=StrictUndefined,
    trim_blocks=True,
    lstrip_blocks=True,
)
_templates.filters.update(ago=ago, local=local)
_templates.globals.update(stylesheet=STYLESHEET, count=count, words_max=WORDS_MAX)


def decisions(page: Page) -> str:
    return _templates.get_template("decisions.html").render(page=page)


def message(heading: str, text: str | None = None, *, signed_out: bool = False) -> str:
    """A page with one message, such as being signed out, and the way on from it."""
    return _templates.get_template("message.html").render(
        heading=heading, text=text, signed_out=signed_out
    )
