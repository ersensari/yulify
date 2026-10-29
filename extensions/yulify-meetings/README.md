# Yulify Meetings (integration scaffold)

This v0.2 portal extension supplies a Meetings navigation page and reads existing
Yulify meeting archives in each available task chat's workspace. Its server uses
`portal.files` and validates the owner chat from the saved state before serving
transcripts, three-minute WAV parts and their transcript/summary files. Titles
are stored separately under the extension data directory; saved recording files
are never renamed or changed. It does not record or transcribe meetings: the
existing Yulify capture API and worker still need to be integrated into v0.2.

The archive scans `portal.folders.list()`: known agent homes, projects, and the
workspaces of sessions of any kind. It reads the state owner through `chats.get`,
so non-task sessions are included; a deleted chat's archive is available when its
folder is still listed and allowed. Deleted-chat workspaces no longer listed as
an agent home, project or live-session folder cannot be discovered via this API.
With sandboxing enabled `likeParent` requires an accessible associated chat, so
an orphan folder with none may be refused. A list is capped at 2,000 entries and
reports truncation. An audio part appears once the recorder has built it.

The full-meeting summary is a prompt placed in chat history, not an identifiable
archive file; queued prompts, intervening conversation, and deleted sessions
make attributing an assistant event to it unreliable. Part summaries are stored
files and are available here. A later recording integration should generate and
atomically save a dedicated summary with explicit status and meeting identity,
without rewriting or guessing at existing conversations.

Build with `node extensions/yulify-meetings/build.mjs` in a v0.2 checkout after
installing its workspace dependencies. Installing/enabling the extension and
wiring existing recording routes are integration work; this scaffold has not
been deployed or validated against production meetings.
