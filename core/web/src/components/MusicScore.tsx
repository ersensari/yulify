import { useEffect, useRef, useState } from "react";
import { LuDownload } from "react-icons/lu";
import { t } from "../i18n";

/** The score remains editable Markdown; only the preview draws the ABC fence. */
export function canvasAbc(content: string): string | undefined {
  return content.match(/^```abc[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/im)?.[1];
}

export function MusicScore({ abc }: { abc: string }) {
  const paper = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    const target = paper.current;
    setError(false);
    setLoading(true);
    void import("abcjs").then(({ default: abcjs }) => {
      if (disposed || !target) return;
      target.replaceChildren();
      const tunes = abcjs.renderAbc(target, abc, {
        responsive: "resize", staffwidth: 640, foregroundColor: "#111827",
        paddingright: 12, paddingleft: 12,
        wrap: { minSpacing: 1.8, maxSpacing: 2.7, preferredMeasuresPerLine: 4 },
      });
      if (!tunes.length || !target.querySelector("svg")) throw new Error("No score rendered");
      setLoading(false);
    }).catch(() => {
      if (!disposed) { setError(true); setLoading(false); }
    });
    return () => { disposed = true; target?.replaceChildren(); };
  }, [abc]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([abc], { type: "text/vnd.abc;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "yula-score.abc"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="not-prose space-y-3" data-music-score>
    {loading && <p role="status" className="text-sm text-fg-muted">{t("Drawing sheet music…")}</p>}
    {error && <p role="alert" className="text-sm text-danger">{t("Could not draw this score. You can inspect or download the ABC source.")}</p>}
    <div className="overflow-x-auto rounded-lg bg-white p-2 text-gray-900" role="img" aria-label={t("Sheet music")} ref={paper} />
    <p className="text-xs text-fg-muted">{t("This is the composition plan, not a transcription of the final recording.")}</p>
    <div className="flex justify-end"><button type="button" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-fg-muted hover:bg-fg/5" onClick={download}><LuDownload aria-hidden />{t("Download ABC")}</button></div>
    <details><summary className="cursor-pointer text-sm text-fg-muted">{t("ABC source")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre text-xs">{abc}</pre></details>
  </div>;
}
