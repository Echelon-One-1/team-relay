"""Build and load the hashed client-sensitive term list.

The plain list lives in the governed Brain (knowledge/org/client-sensitive-terms.txt).
Repositories carry only keyed hashes (HMAC-SHA256) of each name, so the list itself
does not spread client names, and the hashes cannot be reversed without the key.

  python terms.py build                       # Brain list -> ../assets/terms.sha256
  python terms.py build --source F --dest G
"""
import argparse
import functools
import hashlib
import hmac
import os
import secrets
import re
import unicodedata
from pathlib import Path

SALT = "e1-guard:v1:"  # unkeyed: used only in memory when matching from the plain list
KEY_FILE = Path.home() / ".config" / "e1-guard" / "key"
KEYED = "# keyed hmac-sha256 check "


def key():
    """The secret that keys the hashed list: E1_GUARD_KEY, or the key file on this machine. Without it a
    published hashed list could be reversed by guessing names, so hashed lists are always keyed."""
    value = os.environ.get("E1_GUARD_KEY", "").strip()
    if not value and KEY_FILE.exists():
        value = KEY_FILE.read_text(encoding="utf-8").strip()
    return value or None


def make_key():
    if not key():
        KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        KEY_FILE.write_text(secrets.token_hex(32) + "\n", encoding="utf-8")
        KEY_FILE.chmod(0o600)
    return key()


def check_value(secret):
    return digest("check", "e1-guard", secret)


MAX_N = 6
STOP = {"and"}  # "Smith and Jones" also matches "Smith & Jones"
HERE = Path(__file__).resolve().parent
DEFAULT_HASHES = HERE.parent / "assets" / "terms.sha256"
DEFAULT_BRAIN = Path.home() / "OneDrive - Kieran Farrell" / "Codex" / "Brain"
WORD = re.compile(r"[^\W_]+")


def default_source():
    root = Path(os.environ.get("E1_BRAIN_ROOT", DEFAULT_BRAIN))
    return root / "knowledge" / "org" / "client-sensitive-terms.txt"


def _kind(ch):
    if ch.isdigit():
        return "d"
    return "u" if ch.isupper() else "l"


ASCII_PART = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")


def tokenize(text):
    """(start, end, token) for each word part: letters and digits apart, camelCase split, any script."""
    if text.isascii():  # fast path for ordinary code and prose
        return [(m.start(), m.end(), m.group()) for m in ASCII_PART.finditer(text)]
    out = []
    for m in WORD.finditer(text):
        w, base, start = m.group(), m.start(), 0
        if w.isascii():
            out += [(base + p.start(), base + p.end(), p.group()) for p in ASCII_PART.finditer(w)]
            continue
        for i in range(1, len(w)):
            a, b = _kind(w[i - 1]), _kind(w[i])
            nxt = _kind(w[i + 1]) if i + 1 < len(w) else ""
            if (a == "d") != (b == "d") or (a == "l" and b == "u") or (a == "u" and b == "u" and nxt == "l"):
                out.append((base + start, base + i, w[start:i]))
                start = i
        out.append((base + start, base + len(w), w[start:]))
    return out


def norm(token, case_sensitive=False):
    if token.isascii():
        return token if case_sensitive else token.lower()
    plain = "".join(c for c in unicodedata.normalize("NFKD", token) if not unicodedata.combining(c))
    return plain if case_sensitive else plain.lower()


@functools.lru_cache(maxsize=262144)
def digest(mode, form, secret=None):
    """Keyed hash when a secret is given (lists written to disk); salted hash for in-memory plain lists."""
    if secret:
        return hmac.new(secret.encode("utf-8"), (mode + ":" + form).encode("utf-8"), hashlib.sha256).hexdigest()
    return hashlib.sha256((SALT + mode + ":" + form).encode("utf-8")).hexdigest()


class Terms:
    """Hashes of every spaced and joined form, plus first-word hashes so scanning stays fast."""

    def __init__(self, secret=None):
        self.secret = secret  # each list remembers its own key, so lists never mix hashes
        self.ci = {}  # case-insensitive: hash -> category
        self.cs = {}  # exact case: hash -> category
        self.prefix = set()
        self.max_n = 1
        self.warnings = []

    def h(self, mode, form):
        return digest(mode, form, self.secret)

    def add(self, category, term, case_sensitive):
        toks = [norm(t[2], case_sensitive) for t in tokenize(term)]
        toks = [t for t in toks if t.lower() not in STOP]
        if not toks:
            return
        if len(toks) > MAX_N:
            self.warnings.append(f"'{category}' term of {len(toks)} words is longer than {MAX_N} and can never match")
            return
        table, mode = (self.cs, "cs") if case_sensitive else (self.ci, "ci")
        for form in {" ".join(toks), "".join(toks)}:
            table[self.h(mode, form)] = category
        if len(toks) > 1:
            self.prefix.add(self.h("pf" + mode, toks[0]))
        self.max_n = max(self.max_n, len(toks))

    def __len__(self):
        return len(self.ci) + len(self.cs)


def parse(text, secret=None):
    terms = Terms(secret)
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "|" not in line:
            continue
        category, term = (part.strip() for part in line.split("|", 1))
        case_sensitive = category.endswith("!")
        terms.add(category.rstrip("!").strip(), term, case_sensitive)
    return terms


def build(source, dest):
    secret = key()
    if not secret:
        raise SystemExit(f"terms: no key. Run install.py --global (it creates {KEY_FILE}) or set E1_GUARD_KEY.")
    terms = parse(Path(source).read_text(encoding="utf-8"), secret)
    lines = ["# e1-client-data-guard hashed terms. Built from the Brain list; do not edit.",
             KEYED + check_value(secret),
             f"# max-n {terms.max_n}"]
    lines += sorted(f"ci {h} {c}" for h, c in terms.ci.items())
    lines += sorted(f"cs {h} {c}" for h, c in terms.cs.items())
    lines += sorted(f"pf {h} -" for h in terms.prefix)
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    Path(dest).write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return terms


def load(path):
    text = Path(path).read_text(encoding="utf-8")
    stored = next((ln[len(KEYED):].strip() for ln in text.splitlines() if ln.startswith(KEYED)), None)
    if stored is None:
        raise SystemExit(f"e1-guard: {path} is an old unkeyed list. Rebuild it with terms.py build.")
    secret = key()
    if not secret:
        raise SystemExit("e1-guard: the hashed term list needs its key. On GitHub, add the E1_GUARD_KEY "
                         "secret (install.py --repo <path> --set-secret); on a machine, run install.py --global.")
    if check_value(secret) != stored:
        raise SystemExit("e1-guard: E1_GUARD_KEY does not match the key this term list was built with.")
    terms = Terms(secret)
    for line in text.splitlines():
        if line.startswith("# max-n "):
            terms.max_n = int(line.split()[-1])
        elif line and not line.startswith("#"):
            mode, h, category = line.split()
            if mode == "pf":
                terms.prefix.add(h)
            else:
                (terms.cs if mode == "cs" else terms.ci)[h] = category
    return terms


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="hash the plain list")
    b.add_argument("--source", default=str(default_source()))
    b.add_argument("--dest", default=str(DEFAULT_HASHES))
    args = parser.parse_args(argv)
    terms = build(args.source, args.dest)
    for warning in terms.warnings:
        print("warning: " + warning)
    print(f"{len(terms)} hashed forms written to {args.dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
