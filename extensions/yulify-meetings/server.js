// extensions/yulify-meetings/src/server.ts
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
function meetings(portal) {
  const data = path.join(portal.dataDir(), "names");
  mkdirSync(data, { recursive: true, mode: 448 });
  const valid = /^meeting-[\w.-]+$/;
  const nameFile = (chat, stem) => path.join(data, createHash("sha256").update(JSON.stringify([chat, stem])).digest("hex") + ".json");
  const name = (chat, stem) => {
    try {
      const v = JSON.parse(readFileSync(nameFile(chat, stem), "utf8"));
      return typeof v.name === "string" ? v.name : "";
    } catch {
      return "";
    }
  };
  const folderId = (folder) => createHash("sha256").update(folder).digest("hex");
  function locate(folderKey, stem) {
    if (!valid.test(stem) || !/^[a-f0-9]{64}$/.test(folderKey)) throw new Error("Invalid meeting");
    const folder = portal.folders.list().find((f) => folderId(f.path) === folderKey && portal.folders.allowed(f.path));
    if (!folder) throw new Error("Folder not found");
    const base = folder.path;
    const options = { likeParent: true, chats: portal.chats.inFolder(base).map((c) => c.id) };
    const read = (rel) => {
      const result = portal.files.read(base, rel, options);
      if (result.binary) throw new Error("Meeting file is not readable text");
      return result.content;
    };
    const state = JSON.parse(read(`.meeting-notes/${stem}.state.json`));
    if (typeof state.chat !== "string" || !state.chat) throw new Error("Invalid meeting owner");
    const chat = portal.chats.get(state.chat);
    if (chat && portal.chats.folder(chat.id) !== base) throw new Error("Meeting belongs to another folder");
    return { folder, chat, base, options, read, state };
  }
  portal.router.get("/meetings", (_req, res) => {
    const meetings2 = [], warnings = [];
    for (const folder of portal.folders.list()) {
      try {
        if (!portal.folders.allowed(folder.path)) continue;
        const base = folder.path, folderKey = folderId(base);
        const options = { likeParent: true, chats: portal.chats.inFolder(base).map((c) => c.id) };
        const listing = portal.files.list(base, ".meeting-notes", options);
        if (listing.truncated) warnings.push(`${folder.name}: meeting list truncated`);
        for (const entry of listing.entries) {
          const match = /^(meeting-[\w.-]+)\.state\.json$/.exec(entry.name);
          if (!match || entry.type !== "file" || entry.link) continue;
          try {
            const found = locate(folderKey, match[1]);
            meetings2.push({ chatId: folderKey, chatTitle: found.chat?.title ?? folder.name, originalChatId: found.state.chat, orphaned: !found.chat, id: match[1], name: name(folderKey, match[1]), startedAt: found.state.startedAt, recording: !!found.state.recording });
          } catch {
            warnings.push(`${folder.name}: could not read an archive`);
          }
        }
      } catch (e) {
        if (e.code !== "missing") warnings.push(`${folder.name}: unable to read meeting list`);
      }
    }
    meetings2.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
    res.json({ meetings: meetings2, warnings });
  });
  portal.router.patch("/meetings/:chat/:id", portal.http.json({ limit: "4kb" }), (req, res) => {
    try {
      const chat = String(req.params.chat), id = String(req.params.id);
      locate(chat, id);
      const title = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!title || title.length > 160 || /[\u0000-\u001f\u007f]/.test(title)) return res.status(400).json({ error: "Name must be 1\u2013160 characters" });
      const file = nameFile(chat, id), tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify({ name: title }), { mode: 384, flag: "wx" });
      renameSync(tmp, file);
      res.json({ name: title });
    } catch {
      res.status(404).json({ error: "Meeting not found" });
    }
  });
  portal.router.get("/meetings/:chat/:id", (req, res) => {
    try {
      const chat = String(req.params.chat), id = String(req.params.id), found = locate(chat, id);
      const prefix = `.meeting-notes/${id}-audio`;
      let index = { parts: [] };
      try {
        index = JSON.parse(found.read(`${prefix}/index.json`));
      } catch {
      }
      const parts = Array.isArray(index.parts) ? index.parts.filter((p) => Number.isInteger(p.index) && p.index >= 0).map((p) => ({ index: p.index, start: p.start, end: p.end, summaryStatus: p.summary_status, hasAudio: typeof p.file === "string", hasTranscript: typeof p.transcript === "string", hasSummary: typeof p.summary === "string" })) : [];
      let transcript = "";
      try {
        transcript = found.read(`.meeting-notes/${id}.txt`);
      } catch {
      }
      let fullSummary, fullSummaryStatus;
      try {
        const status = JSON.parse(found.read(`.meeting-notes/${id}.summary-status.json`));
        if (status.version === 1 && status.meeting === `${id}.txt` && typeof status.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(status.requestId)) {
          if (status.state === "completed" && status.file === `${id}.summary.md`) {
            fullSummary = found.read(`.meeting-notes/${id}.summary.md`);
            fullSummaryStatus = "completed";
          } else if (["started", "failed", "unavailable"].includes(status.state)) fullSummaryStatus = status.state;
        }
      } catch {
      }
      res.json({ id, chatId: chat, name: name(chat, id), startedAt: found.state.startedAt, recording: !!found.state.recording, transcript, parts, fullSummary, fullSummaryStatus });
    } catch {
      res.status(404).json({ error: "Meeting not found" });
    }
  });
  portal.router.get("/meetings/:chat/:id/parts/:number/:kind", (req, res) => {
    try {
      const found = locate(String(req.params.chat), String(req.params.id)), id = String(req.params.id);
      if (!/^\d+$/.test(String(req.params.number))) throw new Error("Invalid part");
      const root = `.meeting-notes/${id}-audio`, index = JSON.parse(found.read(`${root}/index.json`));
      const part = index.parts?.find((p) => p.index === Number(req.params.number));
      const kind = String(req.params.kind), key = kind === "audio" ? "file" : kind === "transcript" ? "transcript" : kind === "summary" ? "summary" : "";
      const file = part?.[key];
      if (!key || typeof file !== "string" || !/^part-\d+\.(?:wav|txt|summary\.md)$/.test(file) || kind === "audio" && !file.endsWith(".wav") || kind === "summary" && !file.endsWith(".summary.md") || kind === "transcript" && !file.endsWith(".txt")) throw new Error("Part not found");
      const rel = `${root}/${file}`;
      if (kind === "audio") {
        const opened = portal.files.open(found.base, rel, found.options);
        portal.http.send(req, res, { ...opened, mimeType: "audio/wav" });
      } else res.type("text/plain").send(found.read(rel));
    } catch {
      res.status(404).json({ error: "Part not found" });
    }
  });
}
export {
  meetings as default
};
