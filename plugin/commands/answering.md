---
description: Show the command that starts a manual team relay answering session (optional)
disable-model-invocation: true
---

<!-- Generated from manifest.yaml by scripts/generate.ts (pnpm generate); do not edit. -->

You do not need this to answer teammates: a session started with the team-relay channel answers them on its own,
from its folder (reads inside the folder and ordinary answers ship automatically; anything else waits for
`/team-relay:approvals`). This command is the optional manual answering session instead.

Show me, in one code block I can copy, the command that starts my team relay answering session in a
second terminal. Do not run it yourself, and do not change it:

```
"${CLAUDE_PLUGIN_ROOT}/bin/answerer"
```

Then tell me, briefly:

- It signs in with the same sign-in as `/team-relay:login`; no settings are needed. If I have not signed
  in yet, I should run `/team-relay:login` first.
- Only one answerer runs per computer: while a channel working session or the background answerer answers it refuses
  to start (start that session with `TEAM_RELAY_AUTO_ANSWER=0` to use this one instead).
- It reads none of my files by default. To let it read folders without asking, I start it with
  `ANSWERER_READ_DIRS=~/src/app:~/notes` in front of the command (teammates see only the folder names).
  For anything else it asks me in that terminal; credentials are never readable.
- To offer a capability to teammates, I put its two settings in front of the command:

  - Query the staging database (`staging_db_query`, staging): `CAP_STAGING_DB_QUERY_ENABLED=true` and `CAP_STAGING_DB_QUERY_RUNNER=/absolute/path/to/program`.
  - Check a service's health (`service_health`, staging): `CAP_SERVICE_HEALTH_ENABLED=true` and `CAP_SERVICE_HEALTH_RUNNER=/absolute/path/to/program`.
  - Count rows in a production table (`production_db_count`, production): `CAP_PRODUCTION_DB_COUNT_ENABLED=true` and `CAP_PRODUCTION_DB_COUNT_RUNNER=/absolute/path/to/program`. Production data: also needs `ALLOW_PRODUCTION=true`.
