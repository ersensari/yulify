# Yulify upgrade protection

The v0.2 integration is not ready to upgrade an existing Yulify data directory.
The upstream handoffs move media files, drop the old voice, canvas and media
tables, and reduce the saved voice settings. SQLite rollback cannot undo file
moves and the upstream canvas export does not preserve every chat association.

The server therefore refuses to open a database containing those legacy tables
or legacy voice settings. It checks the existing database read-only before
opening it for writing. This is an intentional temporary block, not a migration.
Fresh databases can start normally. Do not point this integration at a live data
directory or bypass this block.

A completed upgrade needs an explicit process operating on a consistent copy of
the database and associated files, preserving voice presets, service settings,
media and canvas ownership, then verifying the result and retaining the original.
That process has not yet been implemented or validated.

## Music score in Canvas

Music job status and audio remain served by Yulify's music router. The old
score-to-canvas endpoint returns HTTP 501 with an explicit message until a
bridge to the v0.2 Canvas extension is implemented. The former in-core Canvas
store must not be reintroduced as a separate invisible store.

## Proposed copy-based migration (not implemented)

Migration needs a consistent SQLite snapshot and independent copies of the
associated files, including any media outside the portal data directory. The
copy must not share writable files or directories with the original. Build a
manifest of database records, file paths, sizes and content hashes; migrate the
copy, verify it against that manifest, and retain the original. A concurrent
portal or file writer requires a coordinated snapshot or a quiescent source.
Do not treat a successful upstream handoff alone as proof of a complete copy.

### Canvas

The old core `canvases` table and the Canvas extension store have matching
fields: ID, session ID, title, content, revision, status, active call, agent
read revision, update time and previous content. A migration can copy rows into
`extension-data/pithagoras-canvas/canvases.db` while preserving IDs, session
associations and restore history. Check every field and the referenced session.
The extension marks unfinished active writes interrupted on startup; verify
that transition and its previous content. In-memory temporary canvases are not
in the SQLite snapshot and need separate handling if they must be retained.
Upstream's Markdown export alone does not preserve these associations.

### Voice

Copy each preset's ID, name, kind, instruction, transcript and clone WAV bytes
into the intended voice provider's private store; compare the recordings by
hash. Preserve the complete original voice settings, including selected voice,
instructions, language, VAD, runtime, STT/TTS addresses and authentication
configuration. Keep secrets private and out of migration logs and manifests.
Map them to the Yulify voice provider and LiveKit bridge explicitly; neither
is implemented by this migration plan. The upstream Voice Servers handoff only
imports speech for the Kokoro runtime, so it does not preserve Yulify's
`audio-cpp`/Breeze setup. Upstream Voice can log rejected presets or settings
and still mark its handoff complete: rejected or unmatched entries must instead
stop verification and remain available for recovery.

### Media

Preserve image and video rows and endpoint settings, page-owned files, caches,
and each chat's workspace and real-folder association. Verify every referenced
file and its hash, as well as row IDs, paths and settings. Upstream moves files
and uses `INSERT OR IGNORE`; an ID, path or content collision must be compared
and treated as a migration failure rather than silently accepted. Missing or
unreadable files must also stop verification with a recoverable report.

Any conflicting IDs, paths, preset values or existing destination data require
an explicit resolution before the migration can be considered successful.
Repeat runs must be idempotent, interrupted runs recoverable, and completion must
be reported only after the copied result passes these checks. No such migration
or validation has yet been implemented.

## Offline Canvas copy tool

`scripts/migrate-yulify-canvas.mjs` prepares only the Canvas extension's
`canvases.db` from an explicitly provided, independent copy of the old portal
database. It does not install that file or open the existing portal. Prepare a
standalone SQLite copy with no WAL, shared-memory or journal sidecars before
running; use a coordinated snapshot or a stopped source. Both command paths
must be absolute. The output must be a new directory outside the source copy's
directory; an existing output is refused rather than merged or overwritten.

```sh
node scripts/migrate-yulify-canvas.mjs --source /path/to/independent-copy/portal.db --output /path/to/new-canvas-export
```

The tool reads the source through a file descriptor and makes its own temporary
snapshot, checks SQLite integrity and required columns, refuses invalid or
orphaned records, inserts into a new database in a transaction, and checks all
fields and the row count. It creates `canvases.db` and `manifest.json` with the
source snapshot hash and record count. It checks for SQLite sidecars before and
after copying; the caller remains responsible for ensuring the input really is
an independent, quiescent copy. A completed directory alone does not remove the
portal's upgrade guard: voice, media, settings, and the connection of this
Canvas file to the extension still need a verified migration. Canvas records
kept only in memory are not included. No end-to-end upgrade has been validated.
