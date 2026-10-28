import { useEffect, useState } from "preact/hooks";
import { stage as stageInfo, type ProgressEvent } from "@/lib/pipeline/events";
import type { JobState } from "@/app/store";

interface Props {
  job: JobState;
}

type StageView = "pending" | "active" | "done" | "skipped" | "warning";

/** Stages can run side by side, so each one's state comes from its own events only. */
function stageState(own: ProgressEvent[]): StageView {
  const last = own.at(-1);
  if (!last) return "pending";
  if (last.status === "done") return own.some((e) => e.status === "warning") ? "warning" : "done";
  if (last.status === "skipped") return "skipped";
  return "active";
}

export function JobStatus({ job }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, Math.round((now - job.startedAt) / 1000));

  return (
    <div class="card job-status" aria-live="polite" id="work-status">
      <div class="card-head">
        <h2>Working…</h2>
        <span class="muted">{elapsed}s</span>
      </div>
      <ol class="stage-list">
        {job.stages.map((stage) => {
          const own = job.events.filter((e) => e.stage === stage);
          const view = stageState(own);
          const last = own.at(-1);
          const { label, streams } = stageInfo(stage);
          const received = job.receivedChars[stage] ?? 0;
          return (
            <li key={stage} class={`stage stage-${view}`}>
              <span class="stage-icon" aria-hidden="true">
                {view === "done" ? "✓" : view === "active" ? "●" : view === "skipped" ? "–" : view === "warning" ? "!" : "○"}
              </span>
              <div class="stage-body">
                <div class="stage-title">{label}</div>
                {last && (
                  <div class="muted small">
                    {last.message}
                    {last.detail ? ` — ${last.detail}` : ""}
                    {streams && view === "active" && received > 0 ? ` (${received.toLocaleString()} characters so far)` : ""}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
