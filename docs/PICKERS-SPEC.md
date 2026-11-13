# Owner-picked sources (superseded)

**Superseded 13 Nov 2026 by local folders only.** This spec (approved 11 Nov 2026, shipped in
PR #17) let owners pick exact GitHub repositories (through a read-only GitHub App) and
shared-drive folders (through Google's Drive Picker), and members' Macs matched local clones and
Drive for desktop mounts to them. All of it is removed: the pickers, the GitHub App, the Drive
picker page, the Drive sign-in on members' Macs, the missing-sources report, and the switch that
let members add folders of their own.

What holds now:

- A team's boundaries are its topic alone (schema v3, `schema/boundaries-vectors.json`). The relay
  refuses a body holding a removed field, naming it, and reads a document stored before as its
  topic. [M10-SPEC.md](M10-SPEC.md) has the dated correction.
- Every member, owner included, chooses up to 20 folders on their own Mac (`/team-relay:setup` or
  `/team-relay:folders`). Inside a git work tree only the files git tracks are read; elsewhere
  every file in the folder; the credential deny list and the secret-name screen apply everywhere.
  Earlier repository roots and own folders are not read from; they are listed once as "previously
  chosen" for the member to add again, and removed from the settings on the next save.
- A member's plugin reports how many folders they chose (0 to 20); owners see the count per
  member, never names or paths. [M11-SPEC.md](M11-SPEC.md) has the dated correction.

The full text of this spec is in the repository's history (`git log -- docs/PICKERS-SPEC.md`).
