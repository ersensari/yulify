# Yulify Meetings (integration scaffold)

This v0.2 portal extension supplies a Meetings navigation page and reads existing
Yulify meeting archives in each available task chat's workspace. Its server uses
`portal.files` and validates the owner chat from the saved state before serving
transcripts, three-minute WAV parts and their transcript/summary files. Titles
are stored separately under the extension data directory; saved recording files
are never renamed or changed. It does not record or transcribe meetings: the
existing Yulify capture API and worker still need to be integrated into v0.2.

The archive scans chats returned by `portal.chats.list()`. Meetings belonging to
removed chats, non-task sessions or workspaces with over 2,000 entries require a
separate discovery strategy. Full-meeting summary messages currently remain in
chat history, rather than an archive file. Part summaries are displayed here.
An audio part is available once the recording pipeline has built it.

Build with `node extensions/yulify-meetings/build.mjs` in a v0.2 checkout after
installing its workspace dependencies. Installing/enabling the extension and
wiring existing recording routes are integration work; this scaffold has not
been deployed or validated against production meetings.
