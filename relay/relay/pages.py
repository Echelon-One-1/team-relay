"""The login pages (M5-SPEC §2 step 4): server-rendered, every interpolated value escaped
with :func:`html.escape` (quotes included), one same-origin stylesheet, no scripts, no
images, no third-party anything. The look follows the console: a cool neutral palette, one
cobalt accent, the system font stack, light and dark.

Every page carries a strict CSP. ``form-action`` names ``http://127.0.0.1:*`` besides
``'self'`` because browsers apply it to the redirect that follows the chooser's POST, and
that redirect (to the member's own plugin listener) is the only place the form leads.

M9-SPEC §3: an account on no team sees "You're not on a team yet" with a form to create
one. The chooser stays one form with the fields it always had (``csrf``, ``team``,
``action``): "Create a new team" is a third button of it (``action=new``) that answers the
create page, whose own form posts to ``/v1/login/create``. So a page never holds two forms,
and a client that submits the chooser as it always did is unaffected. Team names are shown
escaped like everything else.

M9-SPEC §7.2: the chooser lists the account's invitations ("<name> — invited by <member>:
Accept / Decline"). Each answer is a button of the same form, placed after Continue, that
posts to ``/v1/login/invitation`` (``formaction``, ``formnovalidate``) and is named
``accept`` or ``decline`` with the team id as its value; a button sends only its own name, so
Continue still sends exactly ``csrf``, ``team`` and ``action``, and the page adds no input.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from html import escape

from fastapi.responses import HTMLResponse, Response

from .store import LoginChoice

INVITATION_ACTION = "/v1/login/invitation"


@dataclass(frozen=True)
class InvitationView:
    """One open invitation on the chooser: the team, its name, who invited, and as whom."""

    team: str
    name: str
    member: str
    invited_by: str


STYLESHEET_PATH = "/v1/login/style.css"

CSP = (
    "default-src 'none'; style-src 'self'; img-src 'self'; "
    "form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'"
)

SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    # The callback's URL carries Google's code and the chooser's redirect a one-time code:
    # no Referer may leave this origin. Not "no-referrer": with it browsers send
    # "Origin: null" on the chooser's POST, and the relay checks that Origin.
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
}

STYLESHEET = """\
:root {
  color-scheme: light dark;
  --canvas: #f6f7f9;
  --card: #ffffff;
  --text: #1c2130;
  --subtle: #5d6475;
  --border: #e2e5eb;
  --hairline: #eef0f3;
  --signal: #3457d5;
  --signal-text: #ffffff;
  --signal-soft: rgba(52, 87, 213, 0.08);
  --warn-soft: rgba(191, 132, 22, 0.12);
  --warn-text: #7a5410;
  --bad: #c13b2a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #15171c;
    --card: #1c1f26;
    --text: #e8eaef;
    --subtle: #a6acb9;
    --border: #2c303a;
    --hairline: #242830;
    --signal: #7d97f0;
    --signal-text: #10131a;
    --signal-soft: rgba(125, 151, 240, 0.12);
    --warn-soft: rgba(230, 180, 80, 0.12);
    --warn-text: #e6c06a;
    --bad: #f07c6c;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 16px 32px;
  background: var(--canvas);
  color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial,
    sans-serif;
}
main {
  width: 100%;
  max-width: 440px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 28px 28px 24px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 20px;
  color: var(--subtle);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.01em;
}
.brand::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--signal);
}
h1 { margin: 0 0 8px; font-size: 20px; line-height: 1.3; font-weight: 600; }
p { margin: 0 0 12px; }
.subtle { color: var(--subtle); }
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  overflow-wrap: anywhere;
}
dl { margin: 16px 0; padding: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; }
dt { color: var(--subtle); font-size: 13px; }
dd { margin: 0; overflow-wrap: anywhere; }
.warning {
  margin: 16px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--warn-soft);
  color: var(--warn-text);
  font-size: 14px;
}
.command {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  white-space: nowrap;
}
fieldset { border: 0; margin: 16px 0 0; padding: 0; }
legend { padding: 0; margin: 0 0 8px; font-size: 13px; color: var(--subtle); }
.choice {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  margin: 0 0 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.choice:has(input:checked) { border-color: var(--signal); background: var(--signal-soft); }
.choice input { accent-color: var(--signal); margin: 0; width: 16px; height: 16px; }
.choice .team { font-weight: 600; }
.choice .member { color: var(--subtle); font-size: 13px; }
.actions { display: flex; gap: 8px; margin-top: 20px; flex-wrap: wrap; }
button {
  font: inherit;
  font-weight: 500;
  padding: 9px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
  cursor: pointer;
  min-height: 40px;
}
button.primary {
  background: var(--signal);
  border-color: var(--signal);
  color: var(--signal-text);
}
button:focus-visible, .choice:focus-within {
  outline: 2px solid var(--signal);
  outline-offset: 2px;
}
.error h1 { color: var(--bad); }
.field { display: block; margin: 0 0 12px; }
.field .label { display: block; font-size: 13px; color: var(--subtle); margin: 0 0 4px; }
.field .hint { display: block; font-size: 12px; color: var(--subtle); margin: 4px 0 0; }
input[type="text"] {
  width: 100%;
  font: inherit;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
  min-height: 40px;
}
input[type="text"]:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
input[type="text"].mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.form-error {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--bad);
  color: var(--bad);
  font-size: 14px;
}
.secondary-actions {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--hairline);
}
button.link {
  border: 0;
  background: none;
  padding: 4px 0;
  min-height: 0;
  color: var(--signal);
  font-weight: 500;
}
button.link:hover { text-decoration: underline; }
.choice .name { font-weight: 600; }
.invitations { margin: 20px 0 0; padding: 0; list-style: none; }
.invitation {
  padding: 12px 14px;
  margin: 0 0 8px;
  border: 1px dashed var(--border);
  border-radius: 8px;
}
.invitation .name { font-weight: 600; }
.invitation .actions { margin-top: 10px; }
.notice {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--warn-soft);
  color: var(--warn-text);
  font-size: 14px;
}
footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--hairline);
  font-size: 12px; color: var(--subtle); }
@media (max-width: 480px) {
  body { padding-top: 24px; }
  main { padding: 22px 18px 18px; }
  .actions button { flex: 1 1 auto; }
}
"""


# The pages link the stylesheet with its content hash, so a changed one is fetched at once
# while an unchanged one stays cached.
STYLESHEET_VERSION = hashlib.sha256(STYLESHEET.encode("utf-8")).hexdigest()[:12]
STYLESHEET_HREF = f"{STYLESHEET_PATH}?v={STYLESHEET_VERSION}"


def _page(title: str, body: str, *, css_class: str = "") -> str:
    klass = f' class="{escape(css_class)}"' if css_class else ""
    return (
        "<!doctype html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<meta name="referrer" content="same-origin">\n'
        '<meta name="robots" content="noindex, nofollow">\n'
        f"<title>{escape(title)} · Team relay</title>\n"
        f'<link rel="stylesheet" href="{STYLESHEET_HREF}">\n'
        f"</head>\n<body>\n<main{klass}>\n"
        '<p class="brand">Team relay</p>\n'
        f"{body}\n</main>\n</body>\n</html>\n"
    )


def html_response(content: str, status: int = 200) -> Response:
    return HTMLResponse(content, status_code=status, headers=dict(SECURITY_HEADERS))


def message_page(title: str, lines: Sequence[str], *, error: bool = False) -> str:
    """A page of plain text: every line is escaped."""
    paragraphs = "\n".join(f"<p>{escape(line)}</p>" for line in lines)
    return _page(
        title,
        f"<h1>{escape(title)}</h1>\n{paragraphs}\n<footer>You can close this tab.</footer>",
        css_class="error" if error else "",
    )


@dataclass(frozen=True)
class CreateForm:
    """The create-a-team form (M9-SPEC §3): what to prefill (the member's own input when a
    creation was refused, else the suggestions) and the refusal to show, if any."""

    action: str
    name: str = ""
    team: str = ""
    member: str = ""
    error: str | None = None


def _identity(email: str, device: str) -> str:
    return (
        "<dl>"
        f'<dt>Account</dt><dd class="mono">{escape(email)}</dd>'
        f'<dt>Device</dt><dd class="mono">{escape(device)}</dd>'
        "</dl>\n"
        '<p class="warning">Only continue if you just started signing in from your own Claude '
        '(<span class="command">/team-relay:setup</span> or '
        '<span class="command">/team-relay:login</span>).</p>\n'
    )


def _create_fields(form: CreateForm, csrf: str, *, back: bool) -> str:
    error = f'<p class="form-error" role="alert">{escape(form.error)}</p>\n' if form.error else ""
    back_button = (
        '<button type="submit" name="action" value="back" formnovalidate>Back</button>'
        if back
        else ""
    )
    return (
        f'<form method="post" action="{escape(form.action)}">\n'
        f'<input type="hidden" name="csrf" value="{escape(csrf)}">\n'
        f"{error}"
        '<label class="field"><span class="label">Team name</span>'
        f'<input type="text" name="name" value="{escape(form.name)}" maxlength="60" required '
        'autocomplete="off"></label>\n'
        '<label class="field"><span class="label">Team id</span>'
        f'<input class="mono" type="text" name="team" value="{escape(form.team)}" '
        'maxlength="32" pattern="[a-z][a-z0-9\\-]{2,31}" autocomplete="off" '
        'autocapitalize="off" spellcheck="false">'
        '<span class="hint">Lower-case letters, digits and dashes. Leave it empty to make one '
        "from the name.</span></label>\n"
        '<label class="field"><span class="label">Your member id</span>'
        f'<input class="mono" type="text" name="member" value="{escape(form.member)}" '
        'maxlength="32" pattern="[a-z][a-z0-9_]{1,31}" required autocomplete="off" '
        'autocapitalize="off" spellcheck="false">'
        '<span class="hint">How your teammates see you.</span></label>\n'
        '<div class="actions">'
        '<button class="primary" type="submit" name="action" value="create">Create team</button>'
        f"{back_button}"
        '<button type="submit" name="action" value="cancel" formnovalidate>Cancel</button>'
        "</div>\n</form>"
    )


def _invitations(invitations: Sequence[InvitationView]) -> str:
    """The invitations, each with its Accept and Decline buttons (see the module doc)."""
    if not invitations:
        return ""
    items = []
    for inv in invitations:
        team = escape(inv.team)
        items.append(
            '<li class="invitation">'
            f'<span class="name">{escape(inv.name)}</span> '
            f'<span class="member mono">{team}</span> — invited by '
            f'<span class="mono">{escape(inv.invited_by)}</span><br>'
            f'<span class="member">as <span class="mono">{escape(inv.member)}</span></span>'
            '<div class="actions">'
            f'<button class="primary" type="submit" formaction="{INVITATION_ACTION}" '
            f'formnovalidate name="accept" value="{team}">Accept</button>'
            f'<button type="submit" formaction="{INVITATION_ACTION}" formnovalidate '
            f'name="decline" value="{team}">Decline</button>'
            "</div></li>"
        )
    legend = "Your invitation" if len(invitations) == 1 else "Your invitations"
    return (
        f'<fieldset><legend>{legend}</legend>\n<ul class="invitations">\n'
        + "\n".join(items)
        + "\n</ul></fieldset>\n"
    )


def chooser_page(
    *,
    email: str,
    device: str,
    choices: Sequence[LoginChoice],
    csrf: str,
    action: str,
    names: dict[str, str] | None = None,
    preselect: str | None = None,
    invitations: Sequence[InvitationView] = (),
    notice: str | None = None,
) -> str:
    single = len(choices) == 1
    # M6-SPEC §7.5: preselected only when there is exactly one; with several, the member
    # picks (the radios are required, and the relay refuses a POST without a team). A team
    # just created here is preselected (M9-SPEC §3).
    names = names or {}
    options = []
    for choice in choices:
        checked = " checked" if single or choice.team == preselect else ""
        name = names.get(choice.team, choice.team)
        label = (
            f'<span class="name">{escape(name)}</span> '
            f'<span class="member mono">{escape(choice.team)}</span>'
            if name != choice.team
            else f'<span class="team mono">{escape(choice.team)}</span>'
        )
        options.append(
            '<label class="choice">'
            f'<input type="radio" name="team" value="{escape(choice.team)}"{checked} required>'
            f"<span>{label}<br>"
            f'<span class="member">as <span class="mono">{escape(choice.member)}</span></span>'
            "</span></label>"
        )
    legend = "Your team" if single else "Choose a team"
    teams = ""
    buttons = '<button type="submit" name="action" value="cancel" formnovalidate>Cancel</button>'
    if choices:
        teams = f"<fieldset><legend>{legend}</legend>\n" + "\n".join(options) + "\n</fieldset>\n"
        buttons = (
            '<button class="primary" type="submit" name="action" value="continue">Continue'
            "</button>" + buttons
        )
    lead = (
        '<p class="subtle">A Claude Code session asked to sign in with this account.</p>\n'
        if choices
        else "<p>You're not on a team yet. Accept an invitation, or create a team.</p>\n"
    )
    shown = f'<p class="notice" role="status">{escape(notice)}</p>\n' if notice else ""
    body = (
        "<h1>Connect Claude Code to your team</h1>\n"
        + lead
        + shown
        + _identity(email, device)
        + f'<form method="post" action="{escape(action)}">\n'
        f'<input type="hidden" name="csrf" value="{escape(csrf)}">\n'
        + teams
        + f'<div class="actions">{buttons}</div>\n'
        # M9-SPEC §7.2: after Continue, buttons of the same form (see the module doc).
        + _invitations(invitations)
        # M9-SPEC §3: a button of the same form, so the page keeps one form and its fields.
        + '<div class="secondary-actions">'
        '<button class="link" type="submit" name="action" value="new" formnovalidate>'
        "Create a new team</button></div>\n</form>"
    )
    return _page("Connect", body)


def create_page(*, email: str, device: str, csrf: str, form: CreateForm, on_team: bool) -> str:
    """M9-SPEC §3: the create form on a page of its own. For an account on no team yet it
    says so; for one on teams (the chooser's "Create a new team") it offers Back."""
    if on_team:
        head = (
            "<h1>Create a new team</h1>\n"
            '<p class="subtle">You will be its owner, and can add teammates by their Google '
            "email.</p>\n"
        )
    else:
        head = (
            "<h1>You're not on a team yet</h1>\n"
            f'<p>Ask a team owner to add <span class="mono">{escape(email)}</span>, '
            "or create one.</p>\n"
        )
    body = head + _identity(email, device) + _create_fields(form, csrf, back=on_team)
    return _page("Create a team", body)


def stylesheet_response() -> Response:
    return Response(
        STYLESHEET,
        media_type="text/css; charset=utf-8",
        headers={
            "Cache-Control": "public, max-age=3600",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    )
