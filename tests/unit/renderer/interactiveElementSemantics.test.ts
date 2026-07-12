import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOTS = ['packages/desktop/src/renderer/components', 'packages/desktop/src/renderer/pages'];
const NON_NATIVE_INTERACTIVE_TAGS = new Set(['div', 'span', 'section', 'article', 'li', 'label']);
const INTERACTION_HANDLERS = new Set(['onClick', 'onMouseDown', 'onKeyDown', 'onDoubleClick', 'onPointerDown']);
const COMPOSITE_ROLES = /\b(?:button|checkbox|combobox|link|option|radio|tab)\b/;
const MANAGED_OPTION_ROLE = /option/;
const NATIVE_INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'summary']);
const INTERACTIVE_COMPONENTS = new Set([
  'Button',
  'Checkbox',
  'Input',
  'Link',
  'Radio',
  'Select',
  'Switch',
  'Textarea',
]);
const STRUCTURAL_INTERACTIONS = new Set([
  'composite-control',
  'dismiss-backdrop',
  'event-boundary',
  'focus-surface',
  'resize-handle',
  'selection-surface',
]);

const collectTsxFiles = (root: string): string[] => {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (filePath.endsWith('.tsx')) files.push(filePath);
    }
  };
  walk(root);
  return files;
};

const attribute = (node: ts.JsxOpeningLikeElement, source: ts.SourceFile, name: string) =>
  node.attributes.properties.filter(ts.isJsxAttribute).find((candidate) => candidate.name.getText(source) === name);

const attributeValue = (node: ts.JsxOpeningLikeElement, source: ts.SourceFile, name: string): string =>
  attribute(node, source, name)?.initializer?.getText(source).replaceAll(/["']/g, '') ?? '';

const isInteractiveElement = (node: ts.JsxOpeningLikeElement, source: ts.SourceFile): boolean => {
  const tag = node.tagName.getText(source);
  const component = tag.split('.')[0];
  if (NATIVE_INTERACTIVE_TAGS.has(tag)) return true;
  if (tag === 'a' && attribute(node, source, 'href')) return true;
  if (INTERACTIVE_COMPONENTS.has(component)) return true;
  return COMPOSITE_ROLES.test(attributeValue(node, source, 'role'));
};

const isInteractiveContainer = (node: ts.JsxOpeningLikeElement, source: ts.SourceFile): boolean => {
  const tag = node.tagName.getText(source);
  if (NATIVE_INTERACTIVE_TAGS.has(tag)) return true;
  if (tag === 'a' && attribute(node, source, 'href')) return true;
  return COMPOSITE_ROLES.test(attributeValue(node, source, 'role'));
};

const hasAncestorRole = (node: ts.Node, source: ts.SourceFile, role: string): boolean => {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxElement(current) && attributeValue(current.openingElement, source, 'role') === role) return true;
    current = current.parent;
  }
  return false;
};

describe('renderer interaction semantics', () => {
  it('keeps every non-native interaction assigned to a composite role or an explicit structural exception', () => {
    const failures: string[] = [];
    const cwd = process.cwd();

    for (const relativeRoot of SOURCE_ROOTS) {
      for (const filePath of collectTsxFiles(path.join(cwd, relativeRoot))) {
        const source = ts.createSourceFile(
          filePath,
          fs.readFileSync(filePath, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX
        );

        const visit = (node: ts.Node) => {
          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tag = node.tagName.getText(source);
            if (NON_NATIVE_INTERACTIVE_TAGS.has(tag)) {
              const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
              const names = new Set(attributes.map((candidate) => candidate.name.getText(source)));
              const handlers = [...names].filter((name) => INTERACTION_HANDLERS.has(name));

              if (handlers.length > 0) {
                const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
                const location = `${path.relative(cwd, filePath)}:${line}`;
                const auditAttribute = attribute(node, source, 'data-eve-interaction-role');
                const roleAttribute = attribute(node, source, 'role');

                if (auditAttribute) {
                  const auditValue = auditAttribute.initializer?.getText(source).replaceAll(/["']/g, '') ?? '';
                  if (!STRUCTURAL_INTERACTIONS.has(auditValue)) {
                    failures.push(`${location} uses unknown structural interaction "${auditValue}"`);
                  }
                } else if (roleAttribute) {
                  const roleValue = roleAttribute.initializer?.getText(source) ?? '';
                  if (!COMPOSITE_ROLES.test(roleValue)) {
                    failures.push(`${location} uses non-interactive role ${roleValue}`);
                  } else if (!MANAGED_OPTION_ROLE.test(roleValue)) {
                    if (!names.has('tabIndex') || !names.has('onKeyDown')) {
                      failures.push(`${location} composite ${roleValue} needs tabIndex and onKeyDown`);
                    }
                  }
                } else {
                  failures.push(`${location} <${tag}> has ${handlers.join(', ')} without a semantic role`);
                }
              }
            }
          }
          ts.forEachChild(node, visit);
        };

        visit(source);
      }
    }

    expect(failures).toEqual([]);
  });

  it('keeps native buttons explicit and routes component blur through the canonical glass tiers', () => {
    const failures: string[] = [];
    const cwd = process.cwd();

    for (const relativeRoot of SOURCE_ROOTS) {
      for (const filePath of collectTsxFiles(path.join(cwd, relativeRoot))) {
        const sourceText = fs.readFileSync(filePath, 'utf8');
        const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

        for (const match of sourceText.matchAll(/(?:WebkitBackdropFilter|backdropFilter)\s*:\s*(['"])(.*?)\1/g)) {
          if (!match[2].includes('var(--glass-')) {
            const line = source.getLineAndCharacterOfPosition(match.index ?? 0).line + 1;
            failures.push(`${path.relative(cwd, filePath)}:${line} uses a custom component blur`);
          }
        }

        const visit = (node: ts.Node) => {
          if (
            (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
            node.tagName.getText(source) === 'button'
          ) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            if (!attribute(node, source, 'type')) {
              failures.push(`${path.relative(cwd, filePath)}:${line} native button needs an explicit type`);
            }
          }
          ts.forEachChild(node, visit);
        };

        visit(source);
      }
    }

    expect(failures).toEqual([]);
  });

  it('keeps interactive descendants separate and assigns options and tabs to their owning composites', () => {
    const failures: string[] = [];
    const cwd = process.cwd();

    for (const relativeRoot of SOURCE_ROOTS) {
      for (const filePath of collectTsxFiles(path.join(cwd, relativeRoot))) {
        const source = ts.createSourceFile(
          filePath,
          fs.readFileSync(filePath, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX
        );

        const location = (node: ts.Node) => {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          return `${path.relative(cwd, filePath)}:${line}`;
        };

        const visit = (node: ts.Node) => {
          if (ts.isJsxElement(node) && isInteractiveContainer(node.openingElement, source)) {
            const inspectDescendant = (descendant: ts.Node) => {
              if (
                descendant !== node.openingElement &&
                (ts.isJsxOpeningElement(descendant) || ts.isJsxSelfClosingElement(descendant)) &&
                isInteractiveElement(descendant, source)
              ) {
                failures.push(
                  `${location(node.openingElement)} contains nested interactive ${descendant.tagName.getText(source)} at ${location(descendant)}`
                );
                return;
              }
              ts.forEachChild(descendant, inspectDescendant);
            };
            for (const child of node.children) inspectDescendant(child);
          }

          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const role = attributeValue(node, source, 'role');
            const declaredOwner = attributeValue(node, source, 'data-eve-composite-owner');
            if (role === 'option' && declaredOwner !== 'listbox' && !hasAncestorRole(node, source, 'listbox')) {
              failures.push(`${location(node)} option is missing a listbox ancestor`);
            }
            if (role === 'tab' && declaredOwner !== 'tablist' && !hasAncestorRole(node, source, 'tablist')) {
              failures.push(`${location(node)} tab is missing a tablist ancestor`);
            }
          }

          ts.forEachChild(node, visit);
        };

        visit(source);
      }
    }

    expect(failures).toEqual([]);
  });
});
