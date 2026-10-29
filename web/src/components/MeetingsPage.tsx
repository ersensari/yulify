import { useEffect, useState } from "react";
import { LuNotebookPen, LuPlus } from "react-icons/lu";
import { api, type MeetingEntry, type MeetingType } from "../api";
import { PageHeader } from "./PageHeader";

const types: { value: MeetingType; label: string }[] = [
  { value: "general", label: "General meeting" },
  { value: "standup", label: "Stand-up" },
  { value: "planning", label: "Planning" },
  { value: "interview", label: "Interview" },
  { value: "retrospective", label: "Retrospective" },
  { value: "lecture", label: "Lecture" },
];

export function MeetingsPage({ onOpen, onCreated }: { onOpen: (id: string, record?: string) => void; onCreated: () => Promise<unknown> }) {
  const [meetings, setMeetings] = useState<MeetingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<MeetingType>("general");

  useEffect(() => {
    let cancelled = false;
    void api.meetings().then(result => { if (!cancelled) setMeetings(result.meetings); }, e => { if (!cancelled) setError((e as Error).message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const create = async () => {
    if (creating) return;
    setCreating(true); setError(null);
    try {
      const name = title.trim() || `Meeting ${new Date().toLocaleDateString()}`;
      const session = await api.createSession(undefined, name);
      await api.configureMeeting(session.id, name, type);
      await onCreated();
      try { sessionStorage.setItem(`yulify.meeting.start.${session.id}`, "1"); } catch { /* The recording can still be started in the meeting. */ }
      onOpen(session.id);
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  };

  return <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6"><div className="mx-auto max-w-3xl space-y-5">
    <PageHeader icon={<LuNotebookPen />} title="Meetings" description="Record, review and discuss meeting notes in a dedicated conversation." />
    <form className="rounded-xl border border-line bg-surface p-4" onSubmit={e => { e.preventDefault(); void create(); }}>
      <h3 className="mb-3 text-sm font-medium">New meeting</h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-44 flex-1 text-xs text-fg-muted">Name<input className="mt-1 block w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg" value={title} onChange={e => setTitle(e.target.value)} placeholder="Meeting name" maxLength={160} /></label>
        <label className="min-w-44 text-xs text-fg-muted">Type<select className="mt-1 block w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg" value={type} onChange={e => setType(e.target.value as MeetingType)}>{types.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <button type="submit" disabled={creating} className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-white disabled:opacity-50"><LuPlus />{creating ? "Creating…" : "Start meeting"}</button>
      </div>
    </form>
    {error && <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm text-danger">{error}</p>}
    <section><h3 className="mb-3 text-sm font-medium">Previous meetings</h3>
      {loading ? <p className="text-sm text-fg-muted">Loading…</p> : meetings.length === 0 ? <p className="text-sm text-fg-muted">No meetings yet.</p> : <div className="space-y-2">{meetings.map((meeting, index) => <button key={`${meeting.sessionId}-${meeting.transcriptPath || index}`} type="button" onClick={() => onOpen(meeting.sessionId, meeting.recording ? undefined : meeting.transcriptPath)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 text-left hover:bg-fg/5"><span className="min-w-0"><span className="block truncate text-sm font-medium">{meeting.title}</span><span className="text-xs text-fg-muted">{types.find(t => t.value === meeting.type)?.label || "Meeting"} · {meeting.startedAt ? new Date(meeting.startedAt).toLocaleString() : "Date unknown"}</span></span>{meeting.recording && <span className="text-xs text-danger">Recording</span>}</button>)}</div>}
    </section>
  </div></div>;
}
