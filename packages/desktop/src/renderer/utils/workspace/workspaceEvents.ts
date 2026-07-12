export const WORKSPACE_TOGGLE_EVENT = 'aionui-workspace-toggle';
export const WORKSPACE_OPEN_EVENT = 'aionui-workspace-open';
export const WORKSPACE_STATE_EVENT = 'aionui-workspace-state';
export const WORKSPACE_HAS_FILES_EVENT = 'aionui-workspace-has-files';
export const ELEMENTS_RAIL_SELECT_EVENT = 'command-eve-elements-rail-select';

export type ElementsRailTab = 'activity' | 'artifacts' | 'context';

export interface WorkspaceStateDetail {
  collapsed: boolean;
}

export interface WorkspaceHasFilesDetail {
  hasFiles: boolean;
  conversation_id?: string;
  /**
   * True when this signal corresponds to the workspace tree's first load for
   * this conversation. Lets listeners distinguish backend-seeded files
   * (rules/skills present from the start) from files that appear mid-session.
   *
   * Note: a fresh tree mount counts as initial — switching away from a
   * conversation and back will report `isInitial: true` again, so files added
   * while the conversation was unmounted are not detectable here.
   */
  isInitial: boolean;
}

export function dispatchWorkspaceToggleEvent() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_TOGGLE_EVENT));
}

export function dispatchWorkspaceOpenEvent() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_OPEN_EVENT));
}

export function dispatchElementsRailSelectEvent(tab: ElementsRailTab) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ElementsRailTab>(ELEMENTS_RAIL_SELECT_EVENT, { detail: tab }));
}

export function dispatchWorkspaceStateEvent(collapsed: boolean) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<WorkspaceStateDetail>(WORKSPACE_STATE_EVENT, { detail: { collapsed } }));
}

/**
 * 当工作空间文件状态变化时触发
 * Dispatch when workspace files status changes
 */
export function dispatchWorkspaceHasFilesEvent(
  hasFiles: boolean,
  conversation_id: string | undefined,
  isInitial: boolean
) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<WorkspaceHasFilesDetail>(WORKSPACE_HAS_FILES_EVENT, {
      detail: { hasFiles, conversation_id, isInitial },
    })
  );
}
