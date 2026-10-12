import { memo } from "preact/compat";
import type { AppError, JobKind } from "@/app/store";
import { SidePanelIcon } from "./icons";

interface Props {
  /** The job running, if any: the rail says so and can cancel it while the panel is folded away. */
  running: JobKind | null;
  error: AppError | null;
  onExpand: () => void;
  onCancel: () => void;
}

/** The side panel folded into a narrow rail: a button to unfold it, and what would otherwise go unnoticed (a running job, an error). */
export const SideRail = memo(function SideRail({ running, error, onExpand, onCancel }: Props) {
  return (
    <div class="side-rail">
      <button
        type="button"
        class="side-rail-expand"
        aria-label="Show the side panel"
        title="Show the side panel (document, actions, settings)"
        aria-expanded={false}
        aria-controls="side-panel"
        onClick={onExpand}
      >
        <SidePanelIcon />
        <span class="side-rail-label">Document &amp; settings</span>
      </button>
      {running && (
        <>
          <span class="side-rail-busy" role="status" title="A job is running">
            <span class="side-rail-dot" />
            <span class="visually-hidden">Running</span>
          </span>
          <button
            type="button"
            class="btn btn-ghost small side-rail-cancel"
            aria-label="Cancel the running job"
            title="Cancel the running job"
            onClick={onCancel}
          >
            ✕
          </button>
        </>
      )}
      {error && (
        <button
          type="button"
          class="side-rail-error"
          aria-label={`${error.title}: show the side panel`}
          title={`${error.title}: show the side panel`}
          onClick={onExpand}
        >
          !
        </button>
      )}
    </div>
  );
});
