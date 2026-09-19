import { useEffect, useState } from "preact/hooks";
import { STAGE_LABELS, type ProgressEvent, type StageId } from "@/lib/pipeline/events";
import type { JobState } from "@/app/store";
import type { Settings } from "@/lib/storage/settings";

interface Props {
  job: JobState;
  settings: Settings;
}

type StageView = "pending" | "active" | "done" | "skipped" | "warning";

function stagesFor(job: JobState, settings: Settings): StageId[] {
  const stages: StageId[] = [];
  if (job.kind !== "translate") stages.push("prepare", "ocr");
  if (job.kind !== "ocr") {
    stages.push("infer_schema");
    if (settings.bboxAnnotations) stages.push("bbox_annotate");
    stages.push("translate");
    if (settings.structureOriginal) stages.push("structure_original");
    if (settings.blockTranslations) stages.push("block_translate");
  }
  return stages;
}

function stageState(stage: StageId, events: ProgressEvent[], current: StageId): StageView {
  const own = events.filter((e) => e.stage === stage);
  const last = own.at(-1);
  if (!last) return stage === current ? "active" : "pending";
  if (last.status === "done") return own.some((e) => e.status === "warning") ? "warning" : "done";
  if (last.status === "skipped") return "skipped";
  return "active";
}

export function JobStatus({ job, settings }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, Math.round((now - job.startedAt) / 1000));
  const stages = stagesFor(job, settings);

  return (
    <div class="card job-status" aria-live="polite">
      <div class="card-head">
        <h2>Working…</h2>
        <span class="muted">{elapsed}s</span>
      </div>
      <ol class="stage-list">
        {stages.map((stage) => {
          const view = stageState(stage, job.events, job.currentStage);
          const last = job.events.filter((e) => e.stage === stage).at(-1);
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
                    {(stage === "translate" || stage === "structure_original") && view === "active" && job.receivedChars > 0
                      ? ` (${job.receivedChars.toLocaleString()} characters so far)`
                      : ""}
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
