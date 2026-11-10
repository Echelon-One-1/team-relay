---
description: Sign out of your team relay on this computer (revokes this computer's sign-in)
disable-model-invocation: true
---

I ran `/team-relay:logout`. It signed this computer out of the team relay with this command, whose
output follows:

!`/bin/sh "${CLAUDE_PLUGIN_ROOT}/bin/run-node" "${CLAUDE_PLUGIN_ROOT}/dist/logout.js"`

Tell me in one line what that output says. Do not run it again, and do not run anything else. My
working session goes back to "Not connected" within a few seconds; `/team-relay:login` signs in again.
