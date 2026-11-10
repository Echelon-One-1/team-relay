"""The one-command setup script (M11-SPEC §5): ``GET /setup`` serves ``static/setup.sh`` with
``__RELAY_URL__`` replaced by the relay's public origin (``RELAY_PUBLIC_URL``, ``https``) and
``__MARKETPLACE__`` by ``RELAY_PLUGIN_MARKETPLACE`` (a GitHub ``owner/repo``).

Both values are checked at start (a malformed one refuses to start), and again here, against
patterns that admit no character a shell reads as syntax, so what is written into the script
is only ever a plain origin and a plain ``owner/repo``. The script is read once, at start;
when it is not in the image, or either value is unset, ``/setup`` is 404. The script holds no
secret and is the same for everyone.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from .errors import ConfigError

# Shipped as package data (pyproject.toml); written by the plugin's maintainers.
SETUP_SCRIPT_PATH = Path(__file__).resolve().parent / "static" / "setup.sh"
RELAY_URL_PLACEHOLDER = "__RELAY_URL__"
MARKETPLACE_PLACEHOLDER = "__MARKETPLACE__"
# GitHub's limits: an owner 1-39 letters, digits and '-'; a repository 1-100 of those, '.'
# and '_'.
MARKETPLACE_RE = re.compile(r"[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}")
# An https origin as parse_public_url returns it: lower-case DNS characters (or an IPv4
# address) and an optional port; no path, no trailing slash.
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
HTTPS_ORIGIN_RE = re.compile(rf"https://{_LABEL}(?:\.{_LABEL})*(?::[0-9]{{1,5}})?")
# A setup script is small; anything near this is not one.
MAX_SCRIPT_BYTES = 256 * 1024


def parse_plugin_marketplace(raw: str) -> str:
    """``RELAY_PLUGIN_MARKETPLACE``: ``owner/repo`` as GitHub allows it, else a startup error
    (which never quotes the value)."""
    if MARKETPLACE_RE.fullmatch(raw) is None:
        raise ConfigError(
            "RELAY_PLUGIN_MARKETPLACE must be a GitHub owner/repo (e.g. example-org/team-relay)"
        )
    return raw


def render(template: str, public_url: str, marketplace: str) -> str:
    """``template`` with every placeholder replaced; both values checked first."""
    if HTTPS_ORIGIN_RE.fullmatch(public_url) is None:
        raise ConfigError(
            "RELAY_PLUGIN_MARKETPLACE needs RELAY_PUBLIC_URL to be an https origin "
            "(the setup script points members at it)"
        )
    parse_plugin_marketplace(marketplace)
    return template.replace(RELAY_URL_PLACEHOLDER, public_url).replace(
        MARKETPLACE_PLACEHOLDER, marketplace
    )


def load_setup_script(
    path: str | os.PathLike[str], public_url: str, marketplace: str
) -> str | None:
    """The rendered script, or None when there is no file at ``path`` (``/setup`` is then
    404). A file that cannot be read as UTF-8 text refuses to start."""
    try:
        data = Path(path).read_bytes()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ConfigError(f"cannot read the setup script: {exc.strerror}") from None
    if len(data) > MAX_SCRIPT_BYTES:
        raise ConfigError("the setup script is larger than 256 KiB")
    try:
        template = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ConfigError("the setup script is not UTF-8") from None
    return render(template, public_url, marketplace)
