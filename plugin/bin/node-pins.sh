# shellcheck shell=sh
# The Node.js build bin/run-node downloads when this computer has no Node.js 22.12 or newer: the
# official macOS tarball, pinned by version and by SHA-256 (from
# https://nodejs.org/dist/v22.23.4/SHASUMS256.txt). A download with any other hash is refused.
#
# relay/relay/static/setup.sh holds the same three values: the relay serves that script on its own,
# so it cannot read this file. scripts/tests/run-node.test.sh fails when the two differ, so a new
# pin is an edit of both. Plain assignments only: run-node sources this file, and nothing in the
# environment can replace these values.
# shellcheck disable=SC2034
NODE_VERSION='v22.23.4'
# shellcheck disable=SC2034
NODE_SHA256_ARM64='c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428'
# shellcheck disable=SC2034
NODE_SHA256_X64='efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819'
