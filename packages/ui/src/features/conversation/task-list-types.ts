export type TaskListItemState = "pending" | "active" | "done";
/** The glyph states. `failed` is for work that another agent could not finish. */
export type TaskMarkState = TaskListItemState | "failed";

export interface TaskListItem {
  id: string;
  label: string;
  state: TaskListItemState;
  /** The part of an active task that is complete, from 0 to 1. Other states ignore it. */
  progress?: number | undefined;
}
