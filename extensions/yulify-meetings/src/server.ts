import type { ServerPortal } from '@pithagoras/extension-api/server';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Names live in extension data, never in a recording or its recovery state.
export default function meetings(portal: ServerPortal) {
  const data = path.join(portal.dataDir(), 'names');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const valid = /^meeting-[\w.-]+$/;
  const nameFile = (chat: string, stem: string) => path.join(data, createHash('sha256').update(JSON.stringify([chat, stem])).digest('hex') + '.json');
  const name = (chat: string, stem: string): string => {
    try { const v = JSON.parse(readFileSync(nameFile(chat, stem), 'utf8')); return typeof v.name === 'string' ? v.name : ''; } catch { return ''; }
  };
  // The folder hash identifies an allowed portal folder without exposing its path.
  const folderId = (folder: string) => createHash('sha256').update(folder).digest('hex');
  function locate(folderKey: string, stem: string) {
    if (!valid.test(stem) || !/^[a-f0-9]{64}$/.test(folderKey)) throw new Error('Invalid meeting');
    const folder = portal.folders.list().find(f => folderId(f.path) === folderKey && portal.folders.allowed(f.path));
    if (!folder) throw new Error('Folder not found');
    const base = folder.path;
    const options = { likeParent: true, chats: portal.chats.inFolder(base).map(c => c.id) };
    const read = (rel: string) => {
      const result = portal.files.read(base, rel, options);
      if (result.binary) throw new Error('Meeting file is not readable text');
      return result.content;
    };
    const state = JSON.parse(read(`.meeting-notes/${stem}.state.json`));
    if (typeof state.chat !== 'string' || !state.chat) throw new Error('Invalid meeting owner');
    const chat = portal.chats.get(state.chat);
    // A known chat must still belong to this folder. Deleted chats have no row;
    // their archive is readable only through a currently allowed portal folder.
    if (chat && portal.chats.folder(chat.id) !== base) throw new Error('Meeting belongs to another folder');
    return { folder, chat, base, options, read, state };
  }
  portal.router.get('/meetings', (_req, res) => {
    const meetings: unknown[] = [], warnings: string[] = [];
    for (const folder of portal.folders.list()) {
      try {
        if (!portal.folders.allowed(folder.path)) continue;
        const base = folder.path, folderKey = folderId(base);
        const options = { likeParent: true, chats: portal.chats.inFolder(base).map(c => c.id) };
        const listing = portal.files.list(base, '.meeting-notes', options);
        if (listing.truncated) warnings.push(`${folder.name}: meeting list truncated`);
        for (const entry of listing.entries) {
          const match = /^(meeting-[\w.-]+)\.state\.json$/.exec(entry.name);
          if (!match || entry.type !== 'file' || entry.link) continue;
          try {
            const found = locate(folderKey, match[1]);
            meetings.push({ chatId: folderKey, chatTitle: found.chat?.title ?? folder.name, originalChatId: found.state.chat, orphaned: !found.chat, id: match[1], name: name(folderKey, match[1]), startedAt: found.state.startedAt, recording: !!found.state.recording });
          } catch { warnings.push(`${folder.name}: could not read an archive`); }
        }
      } catch (e) {
        if ((e as {code?:string}).code !== 'missing') warnings.push(`${folder.name}: unable to read meeting list`);
      }
    }
    meetings.sort((a: any,b: any) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    res.json({ meetings, warnings });
  });
  portal.router.patch('/meetings/:chat/:id', portal.http.json({ limit: '4kb' }), (req, res) => {
    try {
      const chat = String(req.params.chat), id = String(req.params.id); locate(chat,id);
      const title = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!title || title.length > 160 || /[\u0000-\u001f\u007f]/.test(title)) return res.status(400).json({error:'Name must be 1–160 characters'});
      const file = nameFile(chat,id), tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify({name:title}), { mode:0o600, flag:'wx' }); renameSync(tmp,file);
      res.json({name:title});
    } catch { res.status(404).json({error:'Meeting not found'}); }
  });
  portal.router.get('/meetings/:chat/:id', (req,res) => {
    try {
      const chat=String(req.params.chat), id=String(req.params.id), found=locate(chat,id);
      const prefix=`.meeting-notes/${id}-audio`;
      let index:any={parts:[]}; try { index=JSON.parse(found.read(`${prefix}/index.json`)); } catch { /* Older records may have no saved audio. */ }
      const parts=Array.isArray(index.parts) ? index.parts.filter((p:any) => Number.isInteger(p.index) && p.index>=0).map((p:any)=>({index:p.index,start:p.start,end:p.end,summaryStatus:p.summary_status,hasAudio:typeof p.file==='string',hasTranscript:typeof p.transcript==='string',hasSummary:typeof p.summary==='string'})) : [];
      let transcript=''; try { transcript=found.read(`.meeting-notes/${id}.txt`); } catch { /* recording may still be starting */ }
      res.json({id,chatId:chat,name:name(chat,id),startedAt:found.state.startedAt,recording:!!found.state.recording,transcript,parts});
    } catch { res.status(404).json({error:'Meeting not found'}); }
  });
  portal.router.get('/meetings/:chat/:id/parts/:number/:kind', (req,res) => {
    try {
      const found=locate(String(req.params.chat),String(req.params.id)), id=String(req.params.id);
      if (!/^\d+$/.test(String(req.params.number))) throw new Error('Invalid part');
      const root=`.meeting-notes/${id}-audio`, index=JSON.parse(found.read(`${root}/index.json`));
      const part=index.parts?.find((p:any)=>p.index===Number(req.params.number));
      const kind=String(req.params.kind), key=kind==='audio'?'file':kind==='transcript'?'transcript':kind==='summary'?'summary':'';
      const file=part?.[key];
      if (!key || typeof file!=='string' || !/^part-\d+\.(?:wav|txt|summary\.md)$/.test(file) || (kind==='audio'&&!file.endsWith('.wav')) || (kind==='summary'&&!file.endsWith('.summary.md')) || (kind==='transcript'&&!file.endsWith('.txt'))) throw new Error('Part not found');
      const rel=`${root}/${file}`;
      if (kind==='audio') {
        const opened=portal.files.open(found.base,rel,found.options);
        portal.http.send(req,res,{...opened,mimeType:'audio/wav'});
      } else res.type('text/plain').send(found.read(rel));
    } catch { res.status(404).json({error:'Part not found'}); }
  });
}
