"""Write IAP's access settings with a custom OAuth client (used by deploy-console.sh, deploy-lb.sh).

Usage: python3 iap_oauth_settings.py <client JSON or ""> <out.yaml> <client id or ""> <secret file or "">

Given the Web OAuth client's downloaded JSON, or its id and a file holding only its secret,
writes `access_settings.oauth_settings` to <out.yaml> (created 0600, never overwritten) for
`gcloud iap settings set`, and prints the client id. The secret is never printed.
"""

import json
import os
import re
import sys


def main() -> None:
    client_file, out_path, client_id, secret_file = sys.argv[1:5]
    if client_file:
        with open(client_file, encoding="utf-8") as handle:
            web = json.load(handle).get("web") or {}
        client_id, secret = web.get("client_id"), web.get("client_secret")
    else:
        with open(secret_file, encoding="utf-8") as handle:
            secret = handle.read().strip()
    if not client_id or not re.fullmatch(r"[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com", client_id):
        sys.exit("error: no valid Web OAuth client id")
    if not secret or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", secret):
        sys.exit("error: the secret is missing or not shaped like an OAuth client secret")
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        out.write("access_settings:\n  oauth_settings:\n")
        out.write(f"    client_id: {json.dumps(client_id)}\n")
        out.write(f"    client_secret: {json.dumps(secret)}\n")
    print(client_id)


if __name__ == "__main__":
    main()
