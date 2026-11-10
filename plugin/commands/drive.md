---
description: Connect, check or disconnect your Google Drive for team answers (connect | status | disconnect)
argument-hint: "[connect [your-email] | status | disconnect]"
disable-model-invocation: true
---

I ran `/team-relay:drive $ARGUMENTS`. It ran this command, whose output follows (`connect` opens
Google's sign-in in my browser and waits up to 110 seconds for me to finish there):

!`/bin/sh "${CLAUDE_PLUGIN_ROOT}/bin/run-node" "${CLAUDE_PLUGIN_ROOT}/dist/drive-cli.js" $ARGUMENTS`

Tell me in one line what that output says. Do not run it again, and do not run anything else. The
connection lets my answering session read the team's Google Docs, Sheets and Slides (read-only); its
token stays in this Mac's Keychain and never goes to the relay. If it timed out, I run
`/team-relay:drive connect` again.
