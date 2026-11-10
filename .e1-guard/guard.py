"""E1 client data guard: find and anonymise client-sensitive information before it reaches GitHub.

  guard.py --staged [--fix]       pre-commit: check staged files; --fix anonymises and re-stages
  guard.py --message FILE         commit-msg: anonymise the commit message in place
  guard.py --pre-push --remote R --url U
                                  pre-push: check commits, files and branch names a push would send
  guard.py --all [--fix]          check every tracked file (CI); --fix anonymises the working tree
  guard.py --range A..B [--branch NAME]
                                  check every commit in a range: messages, file names, contents (CI)

Term list: --source <plain list> (Brain) or --terms <hashed list>; defaults to the
skill's assets/terms.sha256. Skip a line with "e1-guard: allow"; skip paths with
globs in .e1-guard/allow (read from the index). Skip a repository with
git config e1guard.skip true; treat one as a client build with e1guard.clientProject true.
With e1guard.publish true, local commits are left whole and only publish.py's scrubbed
branch may be pushed.
"""
import argparse
import fnmatch
import io
import re
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import terms as terms_mod  # noqa: E402

ZERO = "0" * 40
PUBLISH_NAME = "E1 publish"
PUBLISH_EMAIL = "publish@echelonone.com"
PUBLISH_MESSAGE = "Scrubbed copy for GitHub. Client detail stays on the local machine."
PUBLISH_REF = "refs/heads/e1-publish"
CODE_WORD = {"client": "client", "person": "person"}
ALLOW_MARK = "e1-guard: allow"
ALLOW_MAX_LINE = 500
PLACEHOLDER = {"client": "[client]", "person": "[person]"}
MAX_BYTES = 5_000_000

IMAGES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".svgz"}
SAFE_BINARY = {".woff", ".woff2", ".ttf", ".otf", ".eot", ".ico"}
OFFICE = {".docx", ".docm", ".dotx", ".dotm", ".xlsx", ".xlsm", ".xltx", ".xltm",
          ".pptx", ".pptm", ".potx", ".ppsx"}
OPAQUE = {".doc", ".xls", ".ppt", ".msg", ".pst", ".one", ".zip", ".7z", ".rar", ".gz", ".tgz", ".tar"}
PROSE = {".md", ".markdown", ".txt", ".rst", ".adoc", ".html", ".htm"}  # no extension: Dockerfile, Makefile

# Markup and escapes that can sit between the words of a name: tags, entities, \uXXXX, \n, %20.
NOISE = re.compile(r"</?[A-Za-z][A-Za-z0-9]{0,10}\s*/?>|&#?[A-Za-z0-9]{1,8};|\\u[0-9A-Fa-f]{4}|\\[nrt]|%20")
# Characters between the words of a name: spaces, joiners, quotes, dashes (en, em, Word's hyphens),
# soft hyphens and zero-width characters.
GAP_CHARS = r"\s  _\-./'’&+,;*‐‑–—­​‌‍"
GAP = re.compile("(?:[" + GAP_CHARS + "]|" + NOISE.pattern + "|and|AND|And)*")
GAP_MAX = 24
EMAIL = re.compile(r"(?<![\w.+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![\w-])")
ALLOWED_DOMAINS = ("echelonone.com", "example.com", "example.org", "example.net", "anthropic.com",
                   "users.noreply.github.com", "github.com", "noreply.github.com")
PLACEHOLDER_DOMAINS = ("company.com", "domain.com", "brandname.com", "yourcompany.com", "yourdomain.com", "email.com")
RESERVED_TLDS = ("example", "test", "invalid", "localhost", "local")
FILE_SUFFIXES = ("md", "py", "js", "ts", "json", "txt", "html", "css", "yml", "yaml", "png", "jpg", "svg", "gs", "csv")
PLACEHOLDER_LOCAL = re.compile(r"[A-Z]{2,}_[A-Z]{2,}")
PHONE = re.compile(r"(?<![\w+.,])(?:(?:\+61|0)[ -]?4\d{2}[ -]?\d{3}[ -]?\d{3}"
                   r"|(?:\+61[ -]?[2378]|0[2378]|\(0[2378]\))[ -]?\d{4}[ -]?\d{4})(?!\w|[.,]\d)")
SECRETS = [
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:\\n|\s)+[A-Za-z0-9+/=]{20,}"),
]
PLACEHOLDER_VALUE = re.compile(r"(?i)test|example|dummy|fake|placeholder|xxxx|your|redacted|sample")
CARD = re.compile(r"(?<![\w])(?:\d[ -]?){12,18}\d(?![\w])")
CARD_GROUPED = re.compile(r"\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}")
CARD_CONTEXT = re.compile(r"(?i)\b(?:card|visa|mastercard|amex|credit|debit|cc)\b[^\n]{0,30}$")
TEST_CARDS = {"4111111111111111", "4242424242424242", "4012888888881881", "5555555555554444", "5105105105105100",
              "378282246310005", "371449635398431", "6011111111111117", "4000056655665556", "2223003122003222"}
TAX = re.compile(r"(?i)\b(?:TFN|tax file number)\b[^0-9\n]{0,20}((?:\d[ ]?){7,8}\d)(?![\w])")
TFN_WEIGHTS = (1, 4, 3, 7, 5, 8, 6, 9, 10)
# Windows and Git Bash user folders, and macOS /Users (capital U). /home is only a warning.
HOME = re.compile(r"(?<![\w.\-])(?:(?i:[A-Z]:[\\/]+Users[\\/]+)|/[a-z]/Users/|/Users/)([^\\/\s'\"`<>:*?|]+)")
LINUX_HOME = re.compile(r"(?<![\w.\-])/home/([^\\/\s'\"`<>:*?|]+)/")
NOT_A_PERSON = {"public", "default", "default user", "all users", "runner", "user", "username", "you", "yourname",
                "your-name", "name", "me", "shared", "guest", "administrator", "admin", "x", "...", "node", "ubuntu",
                "ec2-user", "vscode", "pi", "app", "appuser", "codespace", "jovyan", "www-data", "git", "circleci"}
# A name that is also an ordinary word (client!) counts in identifiers and slugs (orbit-agency, ORBIT_URL,
# orbitPanel), unless its only joined neighbours make an ordinary phrase (line-of-orbit).
JOIN_STOP = {"of", "in", "on", "at", "out", "far", "near", "hind", "fore", "eye", "line", "first", "second",
             "short", "long", "the", "a", "an", "to", "my", "your", "plain", "clear"}
LFS_POINTER = "version https://git-lfs.github.com/spec/"
REGEXY = re.compile(r"[\[\]{}()$%<>*+?^]")
DRIVE = re.compile(r"https://(?:drive|docs)\.google\.com/[^\s)\"'>\]]+")


@dataclass
class Finding:
    kind: str
    category: str
    start: int
    end: int
    text: str
    replacement: str = ""
    fixable: bool = True
    blocking: bool = True
    line: int = 0
    path: str = ""

    def describe(self):
        where = f"{self.path}:{self.line}" if self.line else self.path
        what = {"term": f"{self.category} name", "file-name": f"{self.category} name in a file or branch name",
                "email": "email address", "phone": "phone number", "path": "personal folder path",
                "secret": "credential or key", "card": "card number", "tax-id": "tax file number",
                "drive-link": "Google Drive link (check it is not a client file)",
                "home": "home folder path (check it is not a personal account)",
                "unscanned": "could not be read"}[self.kind]
        shown = self.text if self.kind not in ("secret", "card", "tax-id") else self.text[:6] + "..."
        arrow = f" -> {self.replacement}" if self.fixable and self.replacement else ""
        if self.kind == "path" and not self.fixable:
            arrow = " (in code or config: use Path.home() or an environment variable)"
        return f"{where}  {what}: {shown}{arrow}"


def luhn(digits):
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
        alt = not alt
    return total % 10 == 0


# ---------------------------------------------------------------- matching

BASE64_RUN = re.compile(r"[A-Za-z0-9+/]{120,}={0,2}")


def noise_spans(text):
    spans = [(m.start(), m.end()) for m in BASE64_RUN.finditer(text)] if len(text) > 120 else []
    if any(ch in text for ch in "<&\\%"):
        spans += [(m.start(), m.end()) for m in NOISE.finditer(text)]
    return sorted(spans)


def word_tokens(text):
    toks = terms_mod.tokenize(text)
    spans, j, keep = noise_spans(text), 0, []
    for s, e, w in toks:
        while j < len(spans) and spans[j][1] <= s:
            j += 1
        if j < len(spans) and spans[j][0] <= s < spans[j][1]:
            continue  # inside a tag, entity or escape: part of the gap
        if w.lower() in terms_mod.STOP:
            continue  # joining words sit in the gap
        keep.append((s, e, w))
    return keep


def single_word(word, terms, memo):
    """(category if the word alone is a term, whether a longer term starts with it). Memoised per word."""
    if word not in memo:
        low, exact = terms_mod.norm(word), terms_mod.norm(word, True)
        memo[word] = (terms.ci.get(terms.h("ci", low)) or terms.cs.get(terms.h("cs", exact)),
                      terms.h("pfci", low) in terms.prefix or terms.h("pfcs", exact) in terms.prefix)
    return memo[word]


def joined_neighbours(text, toks, i):
    """Lower-cased tokens attached to toks[i] by nothing, a hyphen, an underscore or a dot."""
    s, e, _ = toks[i]
    out = []
    if i and text[toks[i - 1][1]:s] in ("", "-", "_", "."):
        out.append(toks[i - 1][2].lower())
    elif s >= 2 and text[s - 1] in "-_" and text[s - 2].isalnum():
        out.append("?")
    if i + 1 < len(toks) and text[e:toks[i + 1][0]] in ("", "-", "_", "."):
        out.append(toks[i + 1][2].lower())
    elif text[e:e + 1] in ("-", "_"):
        out.append("?")  # a slug cut short, as in /^orbit-(row|total)/
    return out


def joined_word(word, terms, memo):
    """Category if the word, capitalised, is a case-sensitive term."""
    key = ("joined", word)
    if key not in memo:
        category = terms.cs.get(terms.h("cs", terms_mod.norm(word, True).capitalize())) if terms.cs else None
        memo[key] = category if category == "client" else None
    return memo[key]


def camel_word(text, toks, i, terms):
    """(start, end, category) when a one-word name is written in parts: ZedCorp for Zedcorp."""
    best, j = None, i
    while j + 1 < len(toks) and j - i < 3 and text[toks[j][1]:toks[j + 1][0]] == "":
        j += 1
        run = toks[i:j + 1]
        low = "".join(terms_mod.norm(w[2]) for w in run)
        exact = "".join(terms_mod.norm(w[2], True) for w in run)
        category = terms.ci.get(terms.h("ci", low)) or terms.cs.get(terms.h("cs", exact))
        if category:
            best = (run[0][0], run[-1][1], category)
    return best


def term_findings(text, terms, kind="term"):
    toks = word_tokens(text)
    found, memo = [], {}
    for i in range(len(toks)):
        alone, longer = single_word(toks[i][2], terms, memo)
        joined = None
        if not alone and terms.cs:
            word = toks[i][2]
            near = joined_neighbours(text, toks, i)
            if (near and not all(w in JOIN_STOP for w in near)) or (len(word) > 2 and word.isupper()):
                joined = joined_word(word, terms, memo)  # in an identifier, or in capitals (ORBIT PTY LTD)
        camel = None
        if i + 1 < len(toks) and text[toks[i][1]:toks[i + 1][0]] == "":
            camel = camel_word(text, toks, i, terms)
        if not alone and not longer and not joined and not camel:
            continue
        best = None
        for n in range(1, terms.max_n + 1):
            if i + n > len(toks) or (n > 1 and not longer):
                break
            if n > 1:
                gap = text[toks[i + n - 2][1]:toks[i + n - 1][0]]
                if len(gap) > GAP_MAX or not GAP.fullmatch(gap):
                    break
            words = toks[i:i + n]
            low = [terms_mod.norm(w[2]) for w in words]
            exact = [terms_mod.norm(w[2], True) for w in words]
            category = None
            for form in {" ".join(low), "".join(low)}:
                category = category or terms.ci.get(terms.h("ci", form))
            for form in {" ".join(exact), "".join(exact)}:
                category = category or terms.cs.get(terms.h("cs", form))
            if category:
                best = (words[0][0], words[-1][1], category)
        if camel and (not best or camel[1] > best[1]):
            best = camel
        if not best and joined:
            best = (toks[i][0], toks[i][1], joined)
        if best:
            s, e, category = best
            found.append(Finding(kind, category, s, e, text[s:e], PLACEHOLDER.get(category, "[redacted]")))
    return found


def email_allowed(m):
    local, domain = m.group(1), m.group(2).lower()
    tld = domain.rsplit(".", 1)[-1]
    return (local.lower() == "git" or tld in RESERVED_TLDS or tld in FILE_SUFFIXES
            or ".example." in "." + domain + "." or PLACEHOLDER_LOCAL.search(local)
            or any(domain == d or domain.endswith("." + d) for d in ALLOWED_DOMAINS + PLACEHOLDER_DOMAINS))


def pattern_findings(text):
    found = [Finding("email", "", m.start(), m.end(), m.group(), "person@example.com")
             for m in EMAIL.finditer(text) if not email_allowed(m)]
    found += [Finding("phone", "", m.start(), m.end(), m.group(), "[phone]") for m in PHONE.finditer(text)]
    for rx in SECRETS:
        found += [Finding("secret", "", m.start(), m.end(), m.group(), fixable=False)
                  for m in rx.finditer(text) if not PLACEHOLDER_VALUE.search(m.group())]
    for m in CARD.finditer(text):
        digits = re.sub(r"\D", "", m.group())
        labelled = CARD_GROUPED.fullmatch(m.group()) or CARD_CONTEXT.search(text[max(0, m.start() - 40):m.start()])
        if (labelled and digits not in TEST_CARDS and 13 <= len(digits) <= 19
                and re.match(r"3[47]|4|5[1-5]|2[2-7]|6", digits) and luhn(digits)):
            found.append(Finding("card", "", m.start(), m.end(), m.group(), fixable=False))
    for m in TAX.finditer(text):
        digits = re.sub(r"\D", "", m.group(1))
        if len(digits) == 9 and not sum(int(d) * w for d, w in zip(digits, TFN_WEIGHTS)) % 11:
            found.append(Finding("tax-id", "", m.start(1), m.end(1), m.group(1), fixable=False))
    for m in HOME.finditer(text):
        if m.group(1).lower() not in NOT_A_PERSON and not REGEXY.search(m.group(1)):
            found.append(Finding("path", "", m.start(), m.end(), m.group(), "~"))
    for m in LINUX_HOME.finditer(text):
        if m.group(1).lower() not in NOT_A_PERSON and not REGEXY.search(m.group(1)):
            found.append(Finding("home", "", m.start(), m.end() - 1, m.group()[:-1], fixable=False, blocking=False))
    found += [Finding("drive-link", "", m.start(), m.end(), m.group(), fixable=False, blocking=False)
              for m in DRIVE.finditer(text)]
    return found


def placeholder(original, category):
    """Identifier-safe stand-in that keeps the original's case: ORBIT_URL -> CLIENT_URL, Orbit -> Client."""
    word = CODE_WORD.get(category, "redacted")
    if original.isupper() and len(original) > 1:
        return word.upper()
    return word.capitalize() if original[:1].isupper() else word


def scan_text(text, terms, path="", client_project=False, honour_allow=True):
    raw = ([] if client_project else term_findings(text, terms)) + pattern_findings(text)
    if client_project:
        raw = [f for f in raw if f.kind not in {"term", "email", "phone", "drive-link", "home"}]
    kept = []
    for blocking in (True, False):  # overlaps are settled within each group, so a warning never hides a block
        group = sorted((f for f in raw if f.blocking == blocking), key=lambda f: (f.start, -(f.end - f.start)))
        last_end = -1
        for f in group:
            if f.start < last_end:
                continue
            line_start = text.rfind("\n", 0, f.start) + 1
            line_end = text.find("\n", f.start)
            line = text[line_start:line_end if line_end != -1 else len(text)]
            if honour_allow and ALLOW_MARK in line and len(line) <= ALLOW_MAX_LINE:
                continue
            f.line = text.count("\n", 0, f.start) + 1
            f.path = path
            kept.append(f)
            last_end = f.end
    return sorted(kept, key=lambda f: f.start)


def scan_path(path, terms, client_project=False):
    if client_project:
        return []
    found = term_findings(path, terms, kind="file-name")
    for f in found:
        f.fixable, f.path = False, path
    return found


def anonymise(text, findings):
    for f in sorted((f for f in findings if f.fixable and f.blocking), key=lambda f: f.start, reverse=True):
        text = text[:f.start] + f.replacement + text[f.end:]
    return text


def office_text(data):
    parts = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            if name.endswith(".xml"):
                xml = z.read(name).decode("utf-8", "replace")
                parts.append(re.sub(r"<[^>]+>", "", re.sub(r"</(?:w:p|a:p|row|si)>", "\n", xml)))
    return "\n".join(parts)


def pdf_text(data):
    from pypdf import PdfReader  # optional dependency
    return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(data)).pages)


def decode(data):
    """(text, editable). UTF-16 and non-UTF-8 text is checked but never rewritten."""
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return data.decode("utf-16", "replace"), False
    sample = data[:400]
    if len(sample) >= 8 and sample[1::2].count(0) > len(sample) // 4 and sample[0::2].count(0) < len(sample) // 8:
        return data.decode("utf-16-le", "replace"), False
    if b"\0" in data[:8000]:
        return None, False
    try:
        return data.decode("utf-8"), True
    except UnicodeDecodeError:
        return data.decode("cp1252", "replace"), False


def unscanned(path, why, blocking):
    return [Finding("unscanned", "", 0, 0, why, fixable=False, blocking=blocking, path=path)]


def scan_bytes(path, data, terms, client_project=False, honour_allow=True):
    """Findings for one file's content. Documents and odd encodings are checked but never edited."""
    suffix = Path(path).suffix.lower()
    if suffix in IMAGES or suffix in SAFE_BINARY:
        return []
    if len(data) > MAX_BYTES:
        return unscanned(path, "larger than 5 MB; check it by eye, then list it in .e1-guard/allow", True)
    if suffix in OPAQUE:
        return unscanned(path, f"{suffix} files cannot be read automatically; convert it or check it by eye "
                               "and list it in .e1-guard/allow", True)
    editable = False
    if suffix in OFFICE or suffix == ".pdf":
        try:
            text = office_text(data) if suffix in OFFICE else pdf_text(data)
        except Exception as exc:  # unreadable, or pypdf missing
            return unscanned(path, f"{type(exc).__name__}; check it by eye", False)
    else:
        text, editable = decode(data)
        if text is not None and text.startswith(LFS_POINTER):
            return unscanned(path, "Git LFS pointer: the file itself is stored outside Git and is not checked. "
                                   "Keep client files out of LFS", True)
        if text is None:
            return unscanned(path, "binary file; check it by eye", False)
    found = scan_text(text, terms, path, client_project, honour_allow)
    prose = suffix in PROSE
    for f in found:
        if not editable or (f.kind in ("path", "phone") and not prose):
            f.fixable = False
        if f.kind == "term" and not prose:
            f.replacement = placeholder(f.text, f.category)
        if suffix in OFFICE or suffix == ".pdf":
            f.line = 0
    return found


# ---------------------------------------------------------------- git helpers

def git(*args, data=None, check=True):
    return subprocess.run(["git", *args], capture_output=True, input=data, check=check).stdout


def git_ok(*args):
    return subprocess.run(["git", *args], capture_output=True).returncode == 0


def repo_root():
    return Path(git("rev-parse", "--show-toplevel").decode().strip())


def ssh_hostname(host):
    try:
        out = subprocess.run(["ssh", "-G", host], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return host
    for line in out.splitlines():
        if line.lower().startswith("hostname "):
            return line.split(None, 1)[1].strip()
    return host


SSH_URL = re.compile(r"^ssh://(?:[^@/\s]+@)?([A-Za-z0-9_.-]{2,})[:/]")
SCP_URL = re.compile(r"^(?:[^@/\\\s]+@)?([A-Za-z0-9_.-]{2,}):(?![/\\])")  # host:path, host may be an ssh alias


def is_github_url(url, resolve=ssh_hostname):
    if "github" in url.lower():
        return True
    m = SSH_URL.match(url) or (None if "://" in url else SCP_URL.match(url))
    return bool(m) and "github" in resolve(m.group(1)).lower()


def pushes_to_github():
    if git("config", "--bool", "e1guard.enforce", check=False).decode().strip() == "true":
        return True
    urls = {line.split()[1] for line in git("remote", "-v", check=False).decode().splitlines() if len(line.split()) > 1}
    return any(is_github_url(u) for u in urls)


def allow_globs(source="index"):
    """Allow-list globs from the index (pre-commit), a commit, or the working tree (CI)."""
    if source == "worktree":
        f = repo_root() / ".e1-guard" / "allow"
        text = f.read_text(encoding="utf-8") if f.exists() else ""
    else:
        ref = ":.e1-guard/allow" if source == "index" else f"{source}:.e1-guard/allow"
        text = git("show", ref, check=False).decode("utf-8", "replace")
    return [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]


def allowed(path, globs):
    return any(fnmatch.fnmatch(path, g) for g in globs)


def raw_changes(*args):
    """(mode, path) for added, copied, modified and renamed entries of a raw -z diff."""
    out = git(*args, "--raw", "-z", "--diff-filter=ACMRT").decode("utf-8", "surrogateescape").split("\0")
    entries, i = [], 0
    while i < len(out) - 1:
        meta = out[i]
        if not meta.startswith(":"):
            i += 1
            continue
        status = meta.split()[-1]
        paths = 2 if status[0] in "RC" else 1
        entries.append((meta.split()[1], out[i + paths]))
        i += 1 + paths
    return entries


def load_terms(args):
    if args.source and Path(args.source).exists():
        return terms_mod.parse(Path(args.source).read_text(encoding="utf-8"))
    path = Path(args.terms) if args.terms else terms_mod.DEFAULT_HASHES
    if not path.exists():
        sys.exit(f"e1-guard: no term list found at {path}")
    return terms_mod.load(path)


def report(title, findings):
    if findings:
        print(title)
        for f in findings:
            print("  " + f.describe())


# ---------------------------------------------------------------- modes

def run_staged(args, terms):
    # Only the staged copy (what the commit will hold) is anonymised; the local file keeps its detail.
    globs = allow_globs("index")
    blocking, warnings, fixed, rewrites = [], [], [], []
    for mode, name in raw_changes("diff", "--cached"):
        if mode == "160000" or allowed(name, globs):
            continue  # submodule pointer, or listed in the allow file
        blocking += scan_path(name, terms, args.client_project)
        data = git("cat-file", "blob", ":" + name)
        found = scan_bytes(name, data, terms, args.client_project)
        warnings += [f for f in found if not f.blocking]
        blocking += [f for f in found if f.blocking and not f.fixable]
        soft = [f for f in found if f.blocking and f.fixable]
        if not soft:
            continue
        if not args.fix or mode == "120000":  # symlink targets are not rewritten
            for f in soft:
                f.fixable = False
            blocking += soft
            continue
        # Replacing one finding can reveal another (an email that began inside a name), so check again.
        text, pending = data.decode("utf-8"), soft
        for _ in range(4):
            text = anonymise(text, pending)
            again = [f for f in scan_bytes(name, text.encode("utf-8"), terms, args.client_project) if f.blocking]
            pending = [f for f in again if f.fixable]
            if not pending or len(pending) != len(again):
                break
        if again:
            blocking += again
            continue
        rewrites.append((mode, name, text))
        fixed += soft
    report("e1-guard: check these (commit not blocked):", warnings)
    report("e1-guard: fix these by hand before committing:", blocking)
    if blocking:
        print("e1-guard: commit stopped. To keep a line on purpose, add 'e1-guard: allow' to it.")
        return 1
    for mode, name, text in rewrites:
        sha = git("hash-object", "-w", "--no-filters", "--stdin", data=text.encode("utf-8")).decode().strip()
        git("update-index", "--cacheinfo", f"{mode},{sha},{name}")
    merging = args.merge or git_ok("rev-parse", "-q", "--verify", "MERGE_HEAD")
    if (rewrites and not merging and git_ok("rev-parse", "-q", "--verify", "HEAD")
            and git_ok("diff", "--cached", "--quiet", "HEAD")):
        print("e1-guard: nothing to commit. The only changes are client details, which stay on this machine.")
        return 1
    report("e1-guard: anonymised in this commit (your copy is unchanged):", fixed)
    return 0


def run_message(args, terms):
    path = Path(args.message)
    text = path.read_text(encoding="utf-8", errors="replace")
    cut = text.find("\n# ------------------------ >8 ------------------------")
    body = text if cut == -1 else text[:cut]
    # "#" lines are scanned too: with -m or -F, Git keeps them in the message.
    found = [f for f in scan_text(body, terms, "commit message", args.client_project) if f.blocking]
    hard = [f for f in found if not f.fixable]
    if hard:
        report("e1-guard: remove these from the commit message:", hard)
        return 1
    if found:
        path.write_text(anonymise(body, found) + text[len(body):], encoding="utf-8")
        report("e1-guard: commit message anonymised:", found)
    return 0


def scan_commits(revs, terms, client_project, honour_allow=True, warnings=None):
    problems = []
    for sha in revs:
        body = git("log", "-1", "--format=%B", sha).decode("utf-8", "replace")
        problems += [f for f in scan_text(body, terms, "commit " + sha[:7], client_project, honour_allow)
                     if f.blocking]
        globs = allow_globs(sha) if honour_allow else []
        parent = sha + "^1"
        diff = (["diff-tree", "-r", "--no-commit-id", parent, sha] if git_ok("rev-parse", "-q", "--verify", parent)
                else ["diff-tree", "-r", "--no-commit-id", "--root", sha])
        for mode, name in raw_changes(*diff):
            if mode == "160000" or allowed(name, globs):
                continue
            problems += scan_path(name, terms, client_project)
            found = scan_bytes(name, git("cat-file", "blob", f"{sha}:{name}"), terms, client_project, honour_allow)
            problems += [f for f in found if f.blocking]
            if warnings is not None:
                warnings += [f for f in found if not f.blocking]
                if Path(name).suffix.lower() in IMAGES or Path(name).suffix.lower() == ".svg":
                    warnings += unscanned(name, "image; check by eye that it shows no client material", False)
    return problems


def remote_tips(remote):
    """Commits the remote really has now. Remote-tracking refs can be stale (a deleted and recreated
    repository), so they are never trusted. None if the remote cannot be asked."""
    r = subprocess.run(["git", "ls-remote", remote], capture_output=True, timeout=60)
    if r.returncode:
        return None
    shas = {line.split()[0] for line in r.stdout.decode().splitlines() if line.strip()}
    return [s for s in shas if git_ok("cat-file", "-e", s + "^{commit}")]


def is_publish_commit(sha):
    info = git("log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce%x00%P%x00%B", sha).decode("utf-8", "replace")
    an, ae, cn, ce, parents, body = info.split("\0", 5)
    return ((an, ae, cn, ce) == (PUBLISH_NAME, PUBLISH_EMAIL, PUBLISH_NAME, PUBLISH_EMAIL)
            and len(parents.split()) <= 1 and body.strip() == PUBLISH_MESSAGE)


def run_pre_push(args, terms):
    if args.url and not is_github_url(args.url):
        return 0
    publish_mode = git("config", "--bool", "e1guard.publish", check=False).decode().strip() == "true"
    publish_tip = git("rev-parse", "-q", "--verify", PUBLISH_REF, check=False).decode().strip()
    problems, refused, tips, warnings = [], [], None, []
    for line in sys.stdin.read().splitlines():
        parts = line.split()
        if len(parts) != 4 or parts[1] == ZERO:
            continue
        local_ref, local, remote_ref, remote = parts
        if publish_mode and (local != publish_tip or remote_ref.startswith("refs/tags/")):
            refused.append(f"{local_ref} -> {remote_ref}")
            continue
        problems += [f for f in scan_path(remote_ref, terms, args.client_project and not publish_mode)]
        if git("cat-file", "-t", local + "^{}").decode().strip() != "commit":
            refused.append(f"{local_ref} -> {remote_ref}: points at a file or folder, which cannot be checked")
            continue
        if git("cat-file", "-t", local).decode().strip() == "tag":  # annotated tag: its message goes too
            body = git("cat-file", "tag", local).decode("utf-8", "replace").split("\n\n", 1)[-1]
            problems += [f for f in scan_text(body, terms, "tag " + remote_ref, args.client_project) if f.blocking]
        if remote != ZERO and git_ok("cat-file", "-e", remote + "^{commit}"):
            revs = git("rev-list", f"{remote}..{local}").decode().split()
        else:  # new branch or a force push: everything the remote does not really have
            if tips is None:
                tips = remote_tips(args.url or args.remote) if (args.url or args.remote) else None
                tips = tips if tips is not None else []
            revs = git("rev-list", local, "--not", *tips).decode().split() if tips else \
                git("rev-list", local).decode().split()
        if publish_mode:
            refused += [f"{sha[:7]} was not made by publish.py" for sha in revs if not is_publish_commit(sha)]
        problems += scan_commits(revs, terms, args.client_project and not publish_mode,
                                 honour_allow=not publish_mode,
                                 warnings=warnings)
    report("e1-guard: check these by eye (push not blocked):", warnings)
    if refused:
        print("e1-guard: push stopped." + (" This repository is in publish mode: only the scrubbed branch "
              "e1-publish, built by publish.py, may be pushed (python publish.py --push)." if publish_mode else ""))
        for item in refused:
            print("  " + item)
        return 1
    if problems:
        report("e1-guard: push stopped. These carry client-sensitive information:", problems)
        print("e1-guard: nothing was sent. Fix the files, then amend or rewrite the commits before pushing.")
        return 1
    return 0


def run_range(args, terms):
    start, _, end = args.range.partition("..")
    end = end or "HEAD"
    if start and start != ZERO and git_ok("cat-file", "-e", start + "^{commit}"):
        revs = git("rev-list", f"{start}..{end}").decode().split()
    else:  # new branch or force push: every commit not already on another branch of the remote
        # --exclude patterns used with --remotes are relative to refs/remotes/
        exclude = ([f"--exclude=origin/{args.branch}", "--exclude=origin/HEAD"]
                   if args.branch else [])
        revs = git("rev-list", end, "--not", *exclude, "--remotes=origin").decode().split()
    problems = scan_commits(revs, terms, args.client_project)
    report("Client-sensitive information in these commits:", problems)
    print(f"e1-guard: {len(revs)} commit(s) checked, {len(problems)} problem(s).")
    return 1 if problems else 0


def run_all(args, terms):
    root = repo_root()
    globs = allow_globs("worktree")
    names = [n for n in git("ls-files", "-z").decode("utf-8", "surrogateescape").split("\0") if n]
    remaining, warnings, fixed = [], [], []
    for name in names:
        file = root / name
        if allowed(name, globs) or not file.is_file():
            continue
        remaining += scan_path(name, terms, args.client_project)
        found = scan_bytes(name, file.read_bytes(), terms, args.client_project)
        warnings += [f for f in found if not f.blocking]
        found = [f for f in found if f.blocking]
        if args.fix and any(f.fixable for f in found):
            text = file.read_bytes().decode("utf-8")
            file.write_bytes(anonymise(text, found).encode("utf-8"))
            fixed += [f for f in found if f.fixable]
            found = [f for f in found if not f.fixable]
        remaining += found
    report("Check these:", warnings)
    report("Anonymised in the working tree:", fixed)
    report("Client-sensitive information found:", remaining)
    print(f"e1-guard: {len(names)} files checked, {len(remaining)} problem(s), {len(fixed)} anonymised, "
          f"{len(warnings)} to check.")
    return 1 if remaining else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true")
    mode.add_argument("--all", action="store_true")
    mode.add_argument("--message")
    mode.add_argument("--range", metavar="A..B")
    mode.add_argument("--pre-push", action="store_true")
    parser.add_argument("--fix", action="store_true")
    parser.add_argument("--merge", action="store_true", help="with --staged: called for a merge commit")
    parser.add_argument("--source", help="plain term list (the Brain copy)")
    parser.add_argument("--terms", help="hashed term list")
    parser.add_argument("--branch", help="with --range: the pushed branch, used when the start commit is missing or zero")
    parser.add_argument("--remote", help="with --pre-push: remote name")
    parser.add_argument("--url", help="with --pre-push: remote URL")
    parser.add_argument("--client-project", action="store_true",
                        help="client build: allow client names and contacts; still block keys, cards, tax numbers "
                             "and personal paths")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    setting = git("config", "--bool", "e1guard.clientProject", check=False).decode().strip()
    args.client_project = args.client_project or setting == "true"
    publish_mode = git("config", "--bool", "e1guard.publish", check=False).decode().strip() == "true"
    if (args.staged or args.message) and (publish_mode or not pushes_to_github()):
        return 0  # publish mode: local commits keep every detail; publish.py sends a scrubbed copy
    terms = load_terms(args)
    if args.staged:
        return run_staged(args, terms)
    if args.message:
        return run_message(args, terms)
    if args.pre_push:
        return run_pre_push(args, terms)
    if args.range:
        return run_range(args, terms)
    return run_all(args, terms)


if __name__ == "__main__":
    raise SystemExit(main())
