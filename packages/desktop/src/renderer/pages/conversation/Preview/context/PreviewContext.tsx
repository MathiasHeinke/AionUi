/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import type { PreviewContentType } from '@/common/types/office/preview';
import type { TypedUIArtifactKind } from '@/common/typedUI';
import { emitter } from '@/renderer/utils/emitter';
import { registerWorkbenchArtifactResolver } from '../services/workbenchArtifactResolver';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/** DOM 片段数据结构 / DOM snippet data structure */
export interface DomSnippet {
  /** 唯一 ID / Unique ID */
  id: string;
  /** 简化标签名（用于显示）/ Simplified tag name (for display) */
  tag: string;
  /** 完整 HTML / Full HTML */
  html: string;
}

export interface PreviewMetadata {
  language?: string;
  title?: string;
  diff?: string;
  file_name?: string;
  file_path?: string; // 工作空间文件的绝对路径 / Absolute file path in workspace
  workspace?: string; // 工作空间根目录 / Workspace root directory
  editable?: boolean; // 是否可编辑 / Whether editable
  truncated?: boolean; // 预览内容是否被截断 / Whether preview content was truncated
  conversation_id?: string; // Owning conversation when the preview was opened from chat
  artifact_id?: string; // Exact conversation-artifact identity for cross-pane resolution
  artifact_kind?: TypedUIArtifactKind; // Typed resolver namespace; never inferred as a path or URL
  artifact_created_at?: number; // Provenance correlation, copied from the canonical artifact record
  source_message_id?: string; // Optional source-message correlation for typed provenance
  typed_ui_attestation_id?: string; // Main-issued attestation; never persisted or used as standalone authority
  typed_ui_content_sha256?: string; // Exact envelope binding for the in-memory typed UI pane
  typed_ui_seat_context_revision?: number; // Main seat-context revision for the in-memory typed UI pane
  workspace_event_prefix?: 'acp' | 'codex' | 'aionrs'; // Backend event namespace for workspace operations
  is_temporary_workspace?: boolean; // Preserve generated workspace identity inside workbench surfaces
}

export interface PreviewTab {
  id: string;
  content: string;
  content_type: PreviewContentType;
  metadata?: PreviewMetadata;
  title: string; // Tab 标题
  isDirty?: boolean; // 是否有未保存的修改 / Whether there are unsaved changes
  originalContent?: string; // 原始内容，用于对比 / Original content for comparison
}

export interface OpenPreviewOptions {
  /**
   * Reuse the active tab instead of opening a new one — used by file-tree
   * browsing so switching files swaps the single preview instead of stacking
   * tabs. Ignored when the active tab has unsaved edits (falls back to a new
   * tab to avoid losing changes).
   */
  replace?: boolean;
}

export type WorkbenchLayoutMode = 'focus' | 'split-left' | 'split-right' | 'split-bottom';

export interface PreviewContextValue {
  // 预览面板状态 / Preview panel state
  isOpen: boolean;
  tabs: PreviewTab[]; // 所有打开的 tabs
  activeTabId: string | null; // 当前激活的 tab ID

  // 获取当前激活的 tab / Get active tab
  activeTab: PreviewTab | null;

  // Command EVE workbench layout / Command EVE Arbeitsflaechen-Layout
  workbenchLayoutMode: WorkbenchLayoutMode;
  setWorkbenchLayoutMode: (mode: WorkbenchLayoutMode) => void;

  // 预览面板操作 / Preview panel operations
  openPreview: (
    content: string,
    type: PreviewContentType,
    metadata?: PreviewMetadata,
    options?: OpenPreviewOptions
  ) => void;
  /** Reveal the existing preview surface without creating or replacing tabs. */
  showPreview: (tabId?: string) => void;
  /** Hide the preview surface while preserving every open tab and dirty buffer. */
  hidePreview: () => void;
  closePreview: () => void;
  closeTab: (tabId: string) => void;
  /** Ask the mounted preview surface to run its dirty-buffer close guard. */
  requestCloseTab: (tabId: string) => void;
  setCloseTabRequestHandler: (handler: ((tabId: string) => void) | null) => void;
  switchTab: (tabId: string) => void;
  updateContent: (content: string) => void;
  saveContent: (tabId?: string) => Promise<boolean>; // 保存内容 / Save content
  findPreviewTab: (type: PreviewContentType, content?: string, metadata?: PreviewMetadata) => PreviewTab | null; // 查找匹配的 tab
  closePreviewByIdentity: (type: PreviewContentType, content?: string, metadata?: PreviewMetadata) => void; // 根据内容关闭指定 tab

  // 发送框集成 / Sendbox integration
  addToSendBox: (text: string) => void;
  setSendBoxHandler: (handler: ((text: string) => void) | null) => void;

  // DOM 片段管理 / DOM snippet management
  domSnippets: DomSnippet[];
  addDomSnippet: (tag: string, html: string) => void;
  removeDomSnippet: (id: string) => void;
  clearDomSnippets: () => void;
}

const PreviewContext = createContext<PreviewContextValue | null>(null);

// 持久化 key / Persistence keys
const PREVIEW_TABS_KEY = 'aionui_preview_tabs';
const PREVIEW_ACTIVE_TAB_ID_KEY = 'aionui_preview_active_tab_id';
const LEGACY_PREVIEW_STATE_KEY = 'aionui_preview_state';
const WORKBENCH_LAYOUT_MODE_KEY = 'aionui_eve_workbench_layout_mode_v1';

const WORKBENCH_LAYOUT_MODES = new Set<WorkbenchLayoutMode>(['focus', 'split-left', 'split-right', 'split-bottom']);

const loadWorkbenchLayoutMode = (): WorkbenchLayoutMode => {
  try {
    const stored = localStorage.getItem(WORKBENCH_LAYOUT_MODE_KEY);
    // The short-lived sidecar experiment wrapped the real chat in a second
    // visual shell. Migrate it to the general two-pane layout instead of
    // preserving product-specific state that Hermes Desktop does not need.
    if (stored === 'sidecar') return 'split-right';
    if (stored && WORKBENCH_LAYOUT_MODES.has(stored as WorkbenchLayoutMode)) {
      return stored as WorkbenchLayoutMode;
    }
  } catch {
    // Ignore unavailable storage and use the stable two-pane workspace.
  }
  return 'split-right';
};

// 仅持久化小体积文本预览，避免大文本导致 localStorage 写入卡顿
// Persist only lightweight text previews to avoid localStorage jank on large files
const MAX_PERSISTED_TAB_CONTENT_LENGTH = 80_000;
const PERSISTABLE_CONTENT_TYPES = new Set<PreviewContentType>(['markdown', 'html', 'code', 'diff']);

const isTypedUIPreviewTab = (tab: PreviewTab): boolean => tab.content_type === 'typed-ui';

const resolveCurrentConversationId = (): string | undefined => {
  if (typeof window === 'undefined') return undefined;
  const match = window.location.hash.match(/^#\/conversation\/([^/?#]+)/);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const scopePreviewMetadata = (meta?: PreviewMetadata): PreviewMetadata | undefined => {
  if (meta?.conversation_id) return meta;
  const conversationId = resolveCurrentConversationId();
  return conversationId ? { ...meta, conversation_id: conversationId } : meta;
};

const sanitizeTabsForPersistence = (input: PreviewTab[]): PreviewTab[] => {
  return input
    .filter((tab) => !isTypedUIPreviewTab(tab))
    .filter((tab) => PERSISTABLE_CONTENT_TYPES.has(tab.content_type))
    .filter((tab) => tab.content.length <= MAX_PERSISTED_TAB_CONTENT_LENGTH)
    .map((tab) => ({
      ...tab,
      isDirty: false,
      originalContent: tab.content,
    }));
};

const parsePersistedTabs = (value: unknown): PreviewTab[] => {
  if (!Array.isArray(value)) return [];

  return value
    .filter((tab): tab is PreviewTab => {
      if (!tab || typeof tab !== 'object') return false;
      const candidate = tab as Partial<PreviewTab>;
      return (
        typeof candidate.id === 'string' &&
        typeof candidate.title === 'string' &&
        typeof candidate.content === 'string' &&
        typeof candidate.content_type === 'string'
      );
    })
    .filter((tab) => !isTypedUIPreviewTab(tab))
    .filter((tab) => PERSISTABLE_CONTENT_TYPES.has(tab.content_type))
    .filter((tab) => tab.content.length <= MAX_PERSISTED_TAB_CONTENT_LENGTH)
    .map((tab) => ({
      ...tab,
      originalContent: typeof tab.originalContent === 'string' ? tab.originalContent : tab.content,
      isDirty: false,
    }));
};

// 从 localStorage 恢复状态 / Restore state from localStorage
// 注意：isOpen 不从 localStorage 恢复，新会话时预览面板默认关闭
// Note: isOpen is not restored from localStorage, preview panel is closed by default for new sessions
const loadPersistedState = (): { isOpen: boolean; tabs: PreviewTab[]; activeTabId: string | null } => {
  try {
    let tabs = parsePersistedTabs(JSON.parse(localStorage.getItem(PREVIEW_TABS_KEY) || '[]'));
    let activeTabId = localStorage.getItem(PREVIEW_ACTIVE_TAB_ID_KEY);

    // 兼容旧版单 key 存储 / Backward compatibility for legacy single-key storage
    if (tabs.length === 0) {
      const legacyStored = localStorage.getItem(LEGACY_PREVIEW_STATE_KEY);
      if (legacyStored) {
        const parsed = JSON.parse(legacyStored) as { tabs?: unknown; activeTabId?: unknown };
        tabs = parsePersistedTabs(parsed.tabs);
        activeTabId = typeof parsed.activeTabId === 'string' ? parsed.activeTabId : activeTabId;
      }
    }

    if (activeTabId && !tabs.some((tab) => tab.id === activeTabId)) {
      activeTabId = tabs[0]?.id || null;
    }

    return {
      isOpen: false, // 始终默认关闭 / Always start closed
      tabs,
      activeTabId,
    };
  } catch {
    // 忽略解析错误 / Ignore parsing errors
  }
  return { isOpen: false, tabs: [], activeTabId: null };
};

export const PreviewProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 从 localStorage 恢复初始状态 / Restore initial state from localStorage
  const persistedState = loadPersistedState();
  const [isOpen, setIsOpen] = useState(persistedState.isOpen);
  const [tabs, setTabs] = useState<PreviewTab[]>(persistedState.tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(persistedState.activeTabId);
  const [workbenchLayoutMode, setWorkbenchLayoutModeState] = useState<WorkbenchLayoutMode>(loadWorkbenchLayoutMode);
  // Mirror activeTabId in a ref so setTabs updaters can read the latest value
  // without adding activeTabId to their dependencies.
  const activeTabIdRef = useRef<string | null>(persistedState.activeTabId);
  const pendingActiveTabIdRef = useRef<string | null>(null);
  const tabsRef = useRef<PreviewTab[]>(persistedState.tabs);
  const closeTabRequestHandlerRef = useRef<((tabId: string) => void) | null>(null);
  // const [sendBoxHandler, setSendBoxHandlerState] = useState<((text: string) => void) | null>(null);
  const sendBoxHandler = useRef<((text: string) => void) | null>(null);
  const [domSnippets, setDomSnippets] = useState<DomSnippet[]>([]);

  useEffect(() => {
    return configService.onSeatRebind(() => {
      setTabs((previousTabs) => {
        const nextTabs = previousTabs.filter((tab) => !isTypedUIPreviewTab(tab));
        if (nextTabs.length === previousTabs.length) return previousTabs;
        const nextActiveTabId = nextTabs.some((tab) => tab.id === activeTabIdRef.current)
          ? activeTabIdRef.current
          : (nextTabs.at(-1)?.id ?? null);
        pendingActiveTabIdRef.current = null;
        activeTabIdRef.current = nextActiveTabId;
        setActiveTabId(nextActiveTabId);
        if (!nextActiveTabId) setIsOpen(false);
        return nextTabs;
      });
    });
  }, []);

  const setWorkbenchLayoutMode = useCallback((mode: WorkbenchLayoutMode) => {
    setWorkbenchLayoutModeState(mode);
    try {
      localStorage.setItem(WORKBENCH_LAYOUT_MODE_KEY, mode);
    } catch {
      // Layout remains usable for the current session when persistence is unavailable.
    }
  }, []);

  useEffect(() => {
    tabsRef.current = tabs;
    const pendingActiveTabId = pendingActiveTabIdRef.current;
    if (pendingActiveTabId && tabs.some((tab) => tab.id === pendingActiveTabId)) {
      pendingActiveTabIdRef.current = null;
      setActiveTabId(pendingActiveTabId);
    }
  }, [tabs]);

  // 持久化 tabs 到 localStorage（仅保存小体积文本 tab）
  // Persist tabs to localStorage (only lightweight text tabs)
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(PREVIEW_TABS_KEY, JSON.stringify(sanitizeTabsForPersistence(tabs)));
        // 迁移后清理旧 key，减少重复解析
        // Remove legacy key after migration to avoid duplicate parsing
        localStorage.removeItem(LEGACY_PREVIEW_STATE_KEY);
      } catch {
        // 忽略存储错误（如存储空间不足）/ Ignore storage errors (e.g., quota exceeded)
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [tabs]);

  // 持久化 activeTabId（单独存储，避免切换 tab 时重复序列化大内容）
  // Persist activeTabId separately to avoid re-serializing large tab content on tab switch
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
    try {
      if (activeTabId) {
        localStorage.setItem(PREVIEW_ACTIVE_TAB_ID_KEY, activeTabId);
      } else {
        localStorage.removeItem(PREVIEW_ACTIVE_TAB_ID_KEY);
      }
    } catch {
      // 忽略存储错误 / Ignore storage errors
    }
  }, [activeTabId]);

  // 追踪是否正在保存（避免与流式更新冲突）/ Track if currently saving (to avoid conflicts with streaming updates)
  const savingFilesRef = useRef<Set<string>>(new Set());

  // 获取当前激活的 tab / Get active tab
  const activeTab = useMemo(() => {
    return tabs.find((tab) => tab.id === activeTabId) || null;
  }, [tabs, activeTabId]);

  const normalize = useCallback((value?: string | null) => value?.trim() || '', []);

  // 从可能包含描述的字符串中提取文件名 / Extract filename from string that may contain description
  const extractFileName = useCallback((str?: string): string | undefined => {
    if (!str) return undefined;
    // 匹配 "Writing to xxx.md" 或 "Reading xxx.txt" 等模式，提取文件名 / Match patterns like "Writing to xxx.md" and extract filename
    const match = str.match(/(?:Writing to|Reading|Creating|Updating)\s+(.+)$/i);
    return match ? match[1] : str;
  }, []);

  const findPreviewTabInList = useCallback(
    (tabList: PreviewTab[], type: PreviewContentType, content?: string, meta?: PreviewMetadata) => {
      const normalizedFileName = normalize(meta?.file_name);
      const normalizedTitle = normalize(meta?.title);
      const normalizedFilePath = normalize(meta?.file_path);
      const normalizedConversationId = normalize(meta?.conversation_id);

      return (
        tabList.find((tab) => {
          if (tab.content_type !== type) return false;
          const tabFileName = normalize(tab.metadata?.file_name);
          const tabTitle = normalize(tab.metadata?.title);
          const tabFilePath = normalize(tab.metadata?.file_path);
          const tabConversationId = normalize(tab.metadata?.conversation_id);

          if (normalizedConversationId && tabConversationId !== normalizedConversationId) return false;

          // 优先通过 file_path 匹配（最可靠）/ Prefer matching by file_path (most reliable)
          if (normalizedFilePath && tabFilePath && normalizedFilePath === tabFilePath) return true;

          // 通过 file_name 匹配时，需要确保路径兼容（避免同名文件在不同目录的冲突）
          // When matching by file_name, ensure path compatibility (avoid conflicts of same-named files in different directories)
          if (normalizedFileName && tabFileName && normalizedFileName === tabFileName) {
            // 如果两边都有 file_path，则必须完全匹配
            // If both have file_path, they must match exactly
            if (normalizedFilePath && tabFilePath) {
              return normalizedFilePath === tabFilePath;
            }
            // 如果只有一边有 file_path，不能仅凭 file_name 匹配
            // If only one side has file_path, cannot match by file_name alone
            if (normalizedFilePath || tabFilePath) {
              return false;
            }
            // 都没有 file_path 时，可以通过 file_name 匹配
            // When neither has file_path, can match by file_name
            return true;
          }

          // 再通过 title 匹配 / Then match by title
          if (!normalizedFileName && normalizedTitle && tabTitle && normalizedTitle === tabTitle) return true;

          // 最后才通过 content 匹配（仅用于小文件）/ Finally match by content (only for small files)
          // 对于大文件（PPT/Excel/Word），不使用 content 比较，避免性能问题
          // For large files (PPT/Excel/Word), skip content comparison to avoid performance issues
          if (!normalizedFileName && !normalizedTitle && !normalizedFilePath && content !== undefined) {
            // 只对小于 100KB 的内容进行比较 / Only compare content smaller than 100KB
            if (content.length < 100000 && tab.content === content) return true;
          }

          return false;
        }) || null
      );
    },
    [normalize]
  );

  const findPreviewTab = useCallback(
    (type: PreviewContentType, content?: string, meta?: PreviewMetadata) => {
      return findPreviewTabInList(tabs, type, content, meta);
    },
    [findPreviewTabInList, tabs]
  );

  const openPreview = useCallback(
    (new_content: string, type: PreviewContentType, meta?: PreviewMetadata, options?: OpenPreviewOptions) => {
      const scopedMeta = scopePreviewMetadata(meta);

      setTabs((prevTabs) => {
        // 如果同一个文件已经打开，则直接激活现有 tab，避免重复 / Focus existing tab when the same file is opened again
        const existingTab = findPreviewTabInList(prevTabs, type, new_content, scopedMeta);

        if (existingTab) {
          pendingActiveTabIdRef.current = existingTab.id;
          return prevTabs.map((tab) => {
            if (tab.id !== existingTab.id) return tab;

            // 如果用户已编辑内容，则保留当前内容，仅更新元数据 / Keep edited content, only merge metadata
            if (tab.isDirty) {
              return scopedMeta ? { ...tab, metadata: { ...tab.metadata, ...scopedMeta } } : tab;
            }

            return {
              ...tab,
              content: new_content,
              metadata: scopedMeta ? { ...tab.metadata, ...scopedMeta } : tab.metadata,
              originalContent: new_content,
            };
          });
        }

        // Tab 标题：优先使用文件名，并从 title 中提取实际文件名
        // Tab title: Prefer file_name and extract actual filename from title
        const fallbackTitle = (() => {
          // 根据内容类型设置默认标题 / Set default title based on content type
          if (type === 'markdown') return 'Markdown';
          if (type === 'diff') return 'Diff';
          if (type === 'code') return `${scopedMeta?.language || 'Code'}`;
          if (type === 'image') return 'Image'; // 图片预览默认标题 / Default title for image preview
          if (type === 'terminal') return 'Terminal';
          if (type === 'workspace-files') return 'Files';
          if (type === 'workspace-review') return 'Review';
          return 'Preview';
        })();

        const title = extractFileName(scopedMeta?.file_name) || extractFileName(scopedMeta?.title) || fallbackTitle;

        // 生成唯一 ID / Generate unique ID
        const tabId = `${type}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        const newTab: PreviewTab = {
          id: tabId,
          content: new_content,
          content_type: type,
          metadata: scopedMeta,
          title,
          isDirty: false,
          originalContent: new_content, // 保存原始内容 / Save original content
        };

        // Single-preview browse mode: reuse the active tab in place instead of
        // stacking a new one — unless it has unsaved edits, then fall back to a
        // new tab so changes aren't lost.
        if (options?.replace) {
          const activeIdx = activeTabIdRef.current
            ? prevTabs.findIndex((tab) => tab.id === activeTabIdRef.current)
            : -1;
          const activeTab = activeIdx >= 0 ? prevTabs[activeIdx] : null;
          if (activeTab && !activeTab.isDirty) {
            pendingActiveTabIdRef.current = activeTab.id;
            const replacedTab: PreviewTab = { ...newTab, id: activeTab.id };
            return prevTabs.map((tab, idx) => (idx === activeIdx ? replacedTab : tab));
          }
        }
        pendingActiveTabIdRef.current = tabId;
        return [...prevTabs, newTab];
      });

      setIsOpen(true);
    },
    [extractFileName, findPreviewTabInList]
  );

  const closePreview = useCallback(() => {
    setIsOpen(false);
    setTabs([]);
    setActiveTabId(null);
    setDomSnippets([]);
  }, []);

  const showPreview = useCallback((tabId?: string) => {
    if (tabId) setActiveTabId(tabId);
    setIsOpen(true);
  }, []);

  useEffect(() => {
    const resolverId = `preview-tabs-${Math.random().toString(36).slice(2)}`;
    return registerWorkbenchArtifactResolver({
      id: resolverId,
      priority: 40,
      canResolve(reference) {
        return tabs.some(
          (tab) =>
            !isTypedUIPreviewTab(tab) &&
            tab.metadata?.conversation_id === reference.conversationId &&
            tab.metadata?.artifact_id === reference.artifactId &&
            tab.metadata?.artifact_kind === reference.kind
        );
      },
      open(reference) {
        const tab = tabs.find(
          (candidate) =>
            !isTypedUIPreviewTab(candidate) &&
            candidate.metadata?.conversation_id === reference.conversationId &&
            candidate.metadata?.artifact_id === reference.artifactId &&
            candidate.metadata?.artifact_kind === reference.kind
        );
        if (!tab) throw new Error('artifact_not_resolved');
        showPreview(tab.id);
      },
    });
  }, [showPreview, tabs]);

  const hidePreview = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Track last-known mtime per file path for external change detection
  const fileMtimeRef = useRef<Map<string, number>>(new Map());

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prevTabs) => {
        // Clean up mtime record for the closed tab
        const tabToClose = prevTabs.find((tab) => tab.id === tabId);
        if (tabToClose?.metadata?.file_path) {
          fileMtimeRef.current.delete(tabToClose.metadata.file_path);
        }

        const newTabs = prevTabs.filter((tab) => tab.id !== tabId);

        // 如果关闭的是当前激活的 tab / If closing the active tab
        if (tabId === activeTabId) {
          if (newTabs.length > 0) {
            // 切换到最后一个 tab / Switch to the last tab
            setActiveTabId(newTabs[newTabs.length - 1].id);
          } else {
            // 没有 tab 了，关闭预览面板 / No more tabs, close preview panel
            setIsOpen(false);
            setActiveTabId(null);
          }
        }

        return newTabs;
      });
    },
    [activeTabId]
  );

  const setCloseTabRequestHandler = useCallback((handler: ((tabId: string) => void) | null) => {
    closeTabRequestHandlerRef.current = handler;
  }, []);

  const requestCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      if (!tab.isDirty) {
        closeTab(tabId);
        return;
      }

      // A dirty tab must become visible before its confirmation modal opens.
      // The mounted PreviewPanel owns the save/discard dialog and registers the
      // same guarded close handler used by its legacy inner tab strip.
      setActiveTabId(tabId);
      setIsOpen(true);
      closeTabRequestHandlerRef.current?.(tabId);
    },
    [closeTab]
  );

  const closePreviewByIdentity = useCallback(
    (type: PreviewContentType, content?: string, meta?: PreviewMetadata) => {
      const tab = findPreviewTab(type, content, meta);
      if (tab) {
        closeTab(tab.id);
      }
    },
    [findPreviewTab, closeTab]
  );

  const updateContent = useCallback(
    (new_content: string) => {
      if (!activeTabId) {
        return;
      }

      // 严格的类型检查，防止 Event 对象被错误传递 / Strict type checking to prevent Event object from being passed incorrectly
      if (typeof new_content !== 'string') {
        return;
      }

      try {
        setTabs((prevTabs) => {
          const updated = prevTabs.map((tab) => {
            if (tab.id === activeTabId) {
              // 检查内容是否与原始内容不同 / Check if content differs from original
              const isDirty = new_content !== tab.originalContent;
              return { ...tab, content: new_content, isDirty };
            }
            return tab;
          });
          return updated;
        });
      } catch {
        // Silently ignore errors
      }
    },
    [activeTabId]
  );

  const saveContent = useCallback(
    async (tabId?: string) => {
      const targetTabId = tabId || activeTabId;
      if (!targetTabId) return false;

      const tab = tabs.find((t) => t.id === targetTabId);
      if (!tab) return false;
      if (tab.metadata?.editable === false) return false;

      // 如果有 file_path 和 workspace，写回工作空间文件 / If file_path and workspace exist, write back to workspace file
      if (tab.metadata?.file_path && tab.metadata?.workspace) {
        try {
          const file_path = tab.metadata.file_path;

          // 标记文件正在保存（避免触发文件监听回调）/ Mark file as being saved (to avoid triggering file watch callback)
          savingFilesRef.current.add(file_path);

          // 使用 IPC 写入文件 / Write file via IPC
          const success = await ipcBridge.fs.writeFile.invoke({
            path: file_path,
            data: tab.content,
          });

          if (success) {
            setTabs((prevTabs) =>
              prevTabs.map((t) => {
                if (t.id === targetTabId) {
                  return { ...t, isDirty: false, originalContent: t.content };
                }
                return t;
              })
            );
          }

          // 延迟移除保存标记（给文件监听一点时间忽略变化）/ Delay removing save flag (give file watch time to ignore change)
          setTimeout(() => {
            savingFilesRef.current.delete(file_path);
          }, 500);

          return success;
        } catch (error) {
          // 发生错误，静默处理（只记录到控制台）/ Error occurred, handle silently (log only)
          // 确保移除保存标记 / Ensure save flag is removed
          if (tab.metadata?.file_path) {
            savingFilesRef.current.delete(tab.metadata.file_path);
          }
          throw error;
        }
      }
      return false;
    },
    [activeTabId, tabs]
  );

  const addToSendBox = useCallback((text: string) => {
    if (sendBoxHandler.current) {
      sendBoxHandler.current(text);
    }
  }, []);

  const setSendBoxHandler = useCallback((handler: ((text: string) => void) | null) => {
    sendBoxHandler.current = handler;
  }, []);

  // DOM 片段管理函数 / DOM snippet management functions
  // 只保留最新的一个片段 / Only keep the latest snippet
  const addDomSnippet = useCallback((tag: string, html: string) => {
    const id = `snippet-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    setDomSnippets([{ id, tag, html }]);
  }, []);

  const removeDomSnippet = useCallback((id: string) => {
    setDomSnippets((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const clearDomSnippets = useCallback(() => {
    setDomSnippets([]);
  }, []);

  // 流式内容订阅：订阅 agent 写入文件时的流式更新（替代文件监听）
  // Streaming content subscription: Subscribe to streaming updates when agent writes files (replaces file watching)
  // 使用防抖优化：等待 agent 完成写入后再更新预览，避免打字动画被频繁中断
  // Use debounce optimization: Wait for agent to finish writing before updating preview, avoiding frequent animation interruptions
  useEffect(() => {
    // 防抖定时器映射：每个文件路径对应一个定时器 / Debounce timer map: one timer per file path
    const debounceTimers = new Map<string, NodeJS.Timeout>();

    const unsubscribe = ipcBridge.fileStream.contentUpdate.on(({ file_path, content, operation }) => {
      // 如果是删除操作，立即处理，不需要防抖 / If delete operation, handle immediately without debounce
      if (operation === 'delete') {
        // 清除该文件的防抖定时器 / Clear debounce timer for this file
        const existingTimer = debounceTimers.get(file_path);
        if (existingTimer) {
          clearTimeout(existingTimer);
          debounceTimers.delete(file_path);
        }

        setTabs((prevTabs) => {
          const tabToClose = prevTabs.find((tab) => tab.metadata?.file_path === file_path);
          if (tabToClose) {
            closeTab(tabToClose.id);
          }
          return prevTabs;
        });
        return;
      }

      // 对写入操作进行防抖：500ms 内没有新的更新才真正更新内容
      // Debounce write operations: Only update content if no new updates within 500ms
      const existingTimer = debounceTimers.get(file_path);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        // 使用函数式更新来访问最新的 tabs 状态 / Use functional update to access latest tabs state
        setTabs((prevTabs) => {
          // 查找受影响的 tabs / Find affected tabs
          const affectedTabs = prevTabs.filter((tab) => tab.metadata?.file_path === file_path);

          if (affectedTabs.length === 0) {
            return prevTabs;
          }

          return prevTabs.map((tab) => {
            if (tab.metadata?.file_path !== file_path) return tab;

            // 如果正在保存或用户已编辑，不更新 / Don't update if saving or user has edited
            if (savingFilesRef.current.has(file_path) || tab.isDirty) {
              return tab;
            }

            return {
              ...tab,
              content,
              originalContent: content,
              isDirty: false,
            };
          });
        });

        // 清除定时器 / Clean up timer
        debounceTimers.delete(file_path);
      }, 500); // 500ms 防抖时间 / 500ms debounce delay

      debounceTimers.set(file_path, timer);
    });

    return () => {
      unsubscribe();
      // 清理所有防抖定时器 / Clean up all debounce timers
      debounceTimers.forEach((timer) => clearTimeout(timer));
      debounceTimers.clear();
    };
  }, [closeTab]); // 只依赖 closeTab，不依赖 tabs，避免重复订阅 / Only depend on closeTab, not tabs, to avoid re-subscribing

  // File mtime polling: detect external file changes (Claude Code CLI, Gemini, etc.) by comparing lastModified.
  // Only polls the active tab to minimize IPC overhead; checks other tabs once on tab switch.
  // Uses polling instead of fileWatch IPC events because buildEmitter's main→renderer event delivery
  // is unreliable after the first emission in Electron (only the first event reaches the renderer).
  const checkFileUpdate = useCallback(
    (tab: PreviewTab) => {
      const file_path = tab.metadata?.file_path;
      if (!file_path || tab.isDirty || savingFilesRef.current.has(file_path)) return;

      void ipcBridge.fs.getFileMetadata
        .invoke({ path: file_path, workspace: tab.metadata?.workspace })
        .then((metadata) => {
          if (!metadata) return;
          const prevMtime = fileMtimeRef.current.get(file_path);
          fileMtimeRef.current.set(file_path, metadata.lastModified);
          if (prevMtime === undefined || metadata.lastModified === prevMtime) return;

          const readPromise =
            tab.content_type === 'image'
              ? ipcBridge.fs.getImageBase64.invoke({ path: file_path, workspace: tab.metadata?.workspace })
              : ipcBridge.fs.readFile.invoke({ path: file_path, workspace: tab.metadata?.workspace });

          void readPromise
            .then((content) => {
              if (content == null) return;
              setTabs((latest) =>
                latest.map((t) => {
                  if (t.metadata?.file_path !== file_path) return t;
                  if (savingFilesRef.current.has(file_path) || t.isDirty) return t;
                  return { ...t, content, originalContent: content, isDirty: false };
                })
              );
            })
            .catch((error) => {
              console.error('[PreviewContext] Failed to read file after mtime change:', file_path, error);
            });
        })
        .catch((error) => {
          console.error('[PreviewContext] Failed to get file metadata:', file_path, error);
        });
    },
    [setTabs]
  );

  // Keep a ref to activeTab so the polling interval always sees the latest object
  // without re-running the effect on every tabs state change.
  const activeTabRef = useRef<PreviewTab | null>(null);
  activeTabRef.current = activeTab;

  const activeFilePath = activeTab?.metadata?.file_path;

  // Poll active tab every 1s
  useEffect(() => {
    if (!activeFilePath) return;

    const pollActive = () => {
      const current = activeTabRef.current;
      if (current) checkFileUpdate(current);
    };
    // Perf (8GB audit): this is a per-SECOND IPC round-trip to main for external
    // file-change detection. Suspend it while the window is hidden so a backgrounded
    // window stops hammering main (macOS App Nap); run one immediate check when the
    // window returns to the foreground so an edit made by an external CLI while
    // backgrounded is picked up as soon as the operator comes back.
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      pollActive();
    };
    const pollId = setInterval(tick, 1000);

    // Check immediately on tab switch
    pollActive();

    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') pollActive();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(pollId);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [activeFilePath, checkFileUpdate]);

  // 监听 preview.open 事件（用于 agent 打开网页预览）/ Listen to preview.open event (for agent to open web preview)
  // 同时监听 IPC 和 renderer emitter 两种方式 / Listen to both IPC and renderer emitter
  useEffect(() => {
    const handleEmitterPreviewOpen = (data: {
      content: string;
      contentType: PreviewContentType;
      metadata?: PreviewMetadata;
    }) => {
      if (data && data.content) {
        openPreview(data.content, data.contentType, data.metadata);
      }
    };

    const handleIpcPreviewOpen = (data: {
      content: string;
      content_type: PreviewContentType;
      metadata?: PreviewMetadata;
    }) => {
      if (data && data.content) {
        openPreview(data.content, data.content_type, data.metadata);
      }
    };

    // 监听 renderer emitter 事件 / Listen to renderer emitter event
    emitter.on('preview.open', handleEmitterPreviewOpen);

    // 监听 IPC 事件（来自主进程，如 chrome-devtools MCP 导航）/ Listen to IPC event (from main process, e.g., chrome-devtools MCP navigation)
    const unsubscribeIpc = ipcBridge.preview.open.on(handleIpcPreviewOpen);

    return () => {
      emitter.off('preview.open', handleEmitterPreviewOpen);
      unsubscribeIpc();
    };
  }, [openPreview]);

  const previewContextValue = useMemo(() => {
    return {
      isOpen,
      tabs,
      activeTabId,
      activeTab,
      workbenchLayoutMode,
      setWorkbenchLayoutMode,
      openPreview,
      showPreview,
      hidePreview,
      closePreview,
      closeTab,
      requestCloseTab,
      setCloseTabRequestHandler,
      switchTab: setActiveTabId,
      updateContent,
      saveContent,
      findPreviewTab,
      closePreviewByIdentity,
      addToSendBox,
      setSendBoxHandler,
      domSnippets,
      addDomSnippet,
      removeDomSnippet,
      clearDomSnippets,
    };
  }, [
    isOpen,
    tabs,
    activeTabId,
    activeTab,
    workbenchLayoutMode,
    setWorkbenchLayoutMode,
    openPreview,
    showPreview,
    hidePreview,
    closePreview,
    closeTab,
    requestCloseTab,
    setCloseTabRequestHandler,
    setActiveTabId,
    updateContent,
    saveContent,
    findPreviewTab,
    closePreviewByIdentity,
    addToSendBox,
    setSendBoxHandler,
    domSnippets,
    addDomSnippet,
    removeDomSnippet,
    clearDomSnippets,
  ]);

  return <PreviewContext.Provider value={previewContextValue}>{children}</PreviewContext.Provider>;
};

export const usePreviewContext = () => {
  const context = useContext(PreviewContext);
  if (!context) {
    throw new Error('usePreviewContext must be used within PreviewProvider');
  }
  return context;
};
