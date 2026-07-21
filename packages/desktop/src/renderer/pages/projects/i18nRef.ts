import type { ProjectWorkspaceI18nRef } from './types';

/**
 * Loose translate signature: main-process i18n refs carry runtime keys that
 * are not part of the statically generated I18nKey union, so resolution goes
 * through a plain string-keyed `t`.
 */
type Translate = (key: string, params?: Record<string, string>) => string;

/**
 * Resolve a main-process i18n reference to localized display text (1.818
 * CAO-P2). `string[]` params are joined with the locale-appropriate list
 * conjunction (' oder ' / ' or '). Falls back to the raw English string when
 * the key is unknown so a renderer/main version skew never surfaces a bare
 * i18n key to the user.
 */
export function resolveProjectWorkspaceI18n(ref: ProjectWorkspaceI18nRef, t: Translate, fallback: string): string {
  const params = Object.fromEntries(
    Object.entries(ref.params ?? {}).map(([paramKey, value]) => [
      paramKey,
      Array.isArray(value) ? value.join(t('common.projects.chatIntent.listOr')) : value,
    ])
  );
  const resolved = t(ref.key, params);
  return resolved === ref.key ? fallback : resolved;
}
