import { useEffect, useState } from "preact/hooks";
import { STAGE_LABELS, type ProgressEvent, type StageId } from "@/lib/pipeline/events";
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

const STREAMING_STAGES: ReadonlySet<StageId> = new Set(["translate", "structure_original"]);

export function JobStatus({ job }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, Math.round((now - job.startedAt) / 1000));

  return (
    <div class="card job-status" aria-live="polite">
      <div class="card-head">
        <h2>Working…</h2>
        <span class="muted">{elapsed}s</span>
      </div>
      <ol class="stage-list">
        {job.stages.map((stage) => {
          const own = job.events.filter((e) => e.stage === stage);
          const view = stageState(own);
          const last = own.at(-1);
          const received = job.receivedChars[stage] ?? 0;
          return (
            <li key={stage} class={`stage stage-${view}`}>
              <span class="stage-icon" aria-hidden="true">
                {view === "done" ? "✓" : view === "active" ? "●" : view === "skipped" ? "–" : view === "warning" ? "!" : "○"}
              </span>
              <div class="stage-body">
                <div class="stage-title">{STAGE_LABELS[stage]}</div>
                {last && (
                  <div class="muted small">
                    {last.message}
                    {last.detail ? ` — ${last.detail}` : ""}
                    {STREAMING_STAGES.has(stage) && view === "active" && received > 0 ? ` (${received.toLocaleString()} characters so far)` : ""}
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
