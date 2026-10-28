import { stage as stageInfo } from "@/lib/pipeline/events";
import type { AppError, JobState } from "@/app/store";

/**
 * One line under the actions for what the main pane shows in full: the stage
 * a job is at, or that it failed. On narrow screens, where the main pane is
 * further down the page, a click goes there.
 */
export function JobBrief({ job, error }: { job: JobState | null; error: AppError | null }) {
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (job) {
    const current = job.events.at(-1)?.stage ?? job.stages[0];
    return (
      <button type="button" class="job-brief" onClick={() => go("work-status")}>
        <span class="job-brief-dot" aria-hidden="true" />
        {current ? stageInfo(current).label : "Starting"}…
      </button>
    );
  }
  if (error) {
    return (
      <button type="button" class="job-brief job-brief-error" onClick={() => go("work-error")}>
        ✕ {error.title}
      </button>
    );
  }
  return null;
}
