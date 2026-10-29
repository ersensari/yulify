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
  function locate(chatId, stem) {
    if (!valid.test(stem)) throw new Error("Invalid meeting");
    const chat = portal.chats.get(chatId);
    if (!chat) throw new Error("Chat not found");
    const base = portal.chats.folder(chat.id);
    const options = { likeParent: true, chats: portal.chats.inFolder(base).map((c) => c.id) };
    const read = (rel) => {
      const result = portal.files.read(base, rel, options);
      if (result.binary) throw new Error("Meeting file is not readable text");
      return result.content;
    };
    const state = JSON.parse(read(`.meeting-notes/${stem}.state.json`));
    if (state.chat !== chat.id) throw new Error("Meeting not found in this chat");
    return { chat, base, options, read, state };
  }
  portal.router.get("/meetings", (_req, res) => {
    const meetings2 = [], warnings = [];
    for (const chat of portal.chats.list()) {
      try {
        const base = portal.chats.folder(chat.id);
        const options = { likeParent: true, chats: portal.chats.inFolder(base).map((c) => c.id) };
        const listing = portal.files.list(base, ".meeting-notes", options);
        if (listing.truncated) warnings.push(`${chat.title}: meeting list truncated`);
        for (const entry of listing.entries) {
          const match = /^(meeting-[\w.-]+)\.state\.json$/.exec(entry.name);
          if (!match || entry.type !== "file" || entry.link) continue;
          try {
            const found = locate(chat.id, match[1]);
            meetings2.push({ chatId: chat.id, chatTitle: chat.title, id: match[1], name: name(chat.id, match[1]), startedAt: found.state.startedAt, recording: !!found.state.recording });
          } catch {
          }
        }
      } catch (e) {
        if (e.code !== "missing") warnings.push(`${chat.title}: unable to read meeting list`);
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
      res.json({ id, chatId: chat, name: name(chat, id), startedAt: found.state.startedAt, recording: !!found.state.recording, transcript, parts });
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
