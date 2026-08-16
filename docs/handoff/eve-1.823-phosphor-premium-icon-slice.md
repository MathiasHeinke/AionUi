# Command EVE 1.823 Phosphor premium icon remediation

Date: 2026-08-16
Linear anchors: MAT-1624, MAT-1844 (reference only; no Linear write)
Integration base: `2c7d4e7547f0dac8652e7bdc949b69d998939ea1`
Superseded candidate base: `ff94a4ba53002c94204adf6fdb5a1a9be2e67384`
Superseded candidate parent: `fac431dab1222d41b73e6dac8676583aaa54090a`
Branch: `codex/eve-1823-phosphor-premium-slice`

## Candidate truth

The direct integration of `fac431dab1222d41b73e6dac8676583aaa54090a`
was rejected against the reviewed integration head. This successor commit closes
that review's bounded source, test, documentation, and visual-harness gaps. It is
still only a source candidate: it does not prove or authorize a cherry-pick,
merge, packaged app, provider, deployment, signing, notarization, upload, or
release.

The previous evidence set under
`artifacts/design-qa/premium-ui/phosphor-candidate-20260816/` is superseded and
non-gating. Its dark workspace record selected an authority menu while reporting
no failure. The repaired harness fails closed for missing triggers, skipped
scenarios, ambiguous ownership, wrong row signatures, and overlays that do not
close through their trigger.

## Remediation scope

- Keep generic/interface desktop icons behind
  `@renderer/components/icons` and mobile icons behind `PremiumIcon`.
- Preserve legacy facade compatibility while proving `two-tone -> duotone`,
  `filled -> fill`, legacy `fill -> color`, and intentional `strokeWidth`
  discard at the facade boundary.
- Preserve dedicated seams for file-type/content renderers, brand marks,
  avatars, native preview assets, and Mermaid/data visualization. These are
  content exceptions, not an alternate source for generic controls or status
  glyphs.
- Replace the current-head Kanban `✓`, `×`, and `–` control/status glyphs
  with semantic facade icons. Free-form backend check text remains textual
  content; its missing value uses the existing localized `unknown` copy.
- Bind each CDP overlay to its clicked trigger through runtime
  `aria-controls`/`aria-owns` when available, otherwise through the newly
  visible candidate set plus the expected row signature.
- Emit repository-relative evidence paths only and verify light, dark, narrow,
  and reduced-motion behavior against the actual renderer.

## Facade adoption on the integration base

This slice is rebased onto `2c7d4e7547f0dac8652e7bdc949b69d998939ea1`, so the
migration is applied to the real source instead of travelling as a patch
artifact. The former handoff patch and its contract test are removed; adoption
is now asserted directly against the files by
`tests/unit/command-eve/phosphorFacadeAdoption.test.ts`.

| File on the integration base                               | Applied change                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `components/layout/Titlebar/DurableWorkActivity/index.tsx` | `Pause`, `PlayOne`, `Power`, `Redo`, `Right`, `Robot`, `Time`: Icon Park import to facade only  |
| `Messages/acp/MessageAcpClarify.tsx`                       | `Comment`, Office/file-type action icons, image/presentation/video icons: import to facade only |
| `ProjectWorkspaceCard/FinalizeProjectAssignmentDialog.tsx` | import to facade only; no dialog, state, or copy change                                         |
| `ProjectWorkspaceCard/index.tsx`                           | import to facade only; the directory implementation stays authoritative                         |
| `pages/kanban/NativeKanbanBoard.tsx`                       | `Computer` import to facade; semantic facade status icons replace generic Unicode status glyphs |
| `typed-ui/messageToolGroup.dom.test.tsx`                   | mock module path to `@renderer/components/icons` only                                           |
| `WebviewHostBrowserControl.dom.test.tsx`                   | mock module path to `@renderer/components/icons` only                                           |

The flat `Messages/components/ProjectWorkspaceCard.tsx` was deleted by the
project assignment work in `7297bc163`. The earlier candidate still carried an
import-only edit for it; that edit is dropped rather than resurrected, and the
successor directory component carries the migration instead.

## Mandatory integration conflict contract

Current integration head `2c7d4e7547f0dac8652e7bdc949b69d998939ea1`
wins for all business logic, security, seat isolation, revisions/CAS, Office
Word/Excel behavior, project assignment/finalization, runtime, Permit, and
provider behavior. Only reviewed icon/import, icon CSS, provider wiring,
dependency/lock, documentation, test-mock, and visual-harness changes may flow
from this candidate.

Specific resolution rules:

1. Apply the current-head import/mock/status patch before removing Icon Park.
   Do not remove `@icon-park/react` until the five production imports and two
   mocks are part of the integration plan.
2. Keep the current directory-based `ProjectWorkspaceCard` implementation. Do
   not resurrect the candidate's deleted flat component.
3. In `WorkProductModeSelector`, preserve current Word/Excel modes, copy, and
   behavior; take only the icon import and reviewed unframed icon CSS.
4. In `MessageGeneratedArtifact`, preserve current TypedUI, attestation,
   security, and ref behavior; take only the import migration.
5. In `AcpSendBox`, preserve current `useSyncExternalStore`, seat/runtime
   ticket, warmup, grounding, and Office semantics; take only reviewed icon
   changes.
6. In the shell/rail overlap, preserve current DurableWorkActivity and callback
   behavior; take only reviewed icon changes.
7. Resolve root manifest and lock files by dependency hunk plus regeneration,
   never by replacing the files wholesale. Preserve `@json-render/core` and
   `@json-render/react` at `0.19.0` plus AionCore commit
   `8c2e7c344f2e50493ec3427625f13715b1e6599c`, then regenerate root and mobile
   locks from the combined manifest.
8. Regenerate derived i18n/approved-copy artifacts from the integrated tree;
   never choose a stale candidate-generated blob over current product copy.

This contract preserves the atomic preview/commit CAS boundary, seat boundary,
and revision boundary. The candidate makes no integration claim.

## Portable visual QA

The repaired CDP gauntlet ran against a fresh temporary Electron profile with
the existing development-only registration gate switch, auto-update disabled,
the bundled local AionCore, and no production profile or provider call.

Evidence:
`artifacts/design-qa/premium-ui/phosphor-remediation-20260816/premium-ui-gauntlet-report.json`

- schema `command-eve-premium-ui-gauntlet/v2`;
- 8/8 route captures across `/guid`, Appearance, Authority, and component
  showcase in light and dark;
- 8/8 owned-overlay captures: tools, authority, workspace, and narrow authority
  in both themes;
- every trigger found, every overlay selected through
  `newly-visible-signature`, every expected row signature matched, and every
  selected overlay closed through its own trigger;
- the dark workspace capture contains `Anderen Ordner auswählen` and
  `Kein Projekt`, not authority rows;
- both narrow authority overlays are bounded at 352 px, use
  `overflow-y: auto`, and have a larger scroll height than client height;
- 2/2 reduced-motion probes report the media query active, animation name
  `none`, and both semantic motion tokens at `0ms`;
- 0 report failures, 0 renderer runtime errors, 0 fast 100-250 ms interaction
  findings, and 0 scrollbar drift findings;
- report and screenshot paths are repository-relative; an
  absolute-candidate-path scan returns no matches.

Manual inspection covered light tools, dark workspace, light narrow authority,
and dark reduced-motion captures. It confirmed correct icon alignment, visible
light/dark contrast, the intended Workspace identity, bounded narrow scrolling,
and the absence of a stray overlay in the reduced-motion capture.

A fresh-profile background runtime bootstrap separately logged a Python PPTX
import failure. It did not affect the renderer, CDP ownership checks,
screenshots, or route runtime gate and is not represented as source/release
truth.

## Verification boundary

| Gate                                                 | Result                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| Facade adoption on the integration base              | PASS on exact `2c7d4e754`                                        |
| Harness/core syntax                                  | PASS                                                             |
| Remediation unit tests                               | 22/22 PASS                                                       |
| Focused renderer/workspace/theme contracts           | 132/132 PASS                                                     |
| Root TypeScript                                      | PASS                                                             |
| Mobile TypeScript                                    | PASS                                                             |
| Root lint                                            | 0 errors, 999 warnings                                           |
| Mobile lint                                          | 0 errors, 10 warnings; generated Expo config removed             |
| Mobile facade test                                   | 3/3 PASS                                                         |
| Full mobile Jest                                     | 83 PASS, 5 unchanged Bridge-test failures                        |
| Targeted format                                      | PASS on 11 remediation/evidence files                            |
| Full-repository format                               | 3 unchanged Parent files remain unformatted                      |
| i18n key generation                                  | PASS, no diff                                                    |
| Approved-copy check                                  | Parent baseline remains out of date: +86 / -2 records            |
| Portable Light/Dark/narrow/reduced-motion CDP matrix | 8 routes, 8 owned overlays, 2 reduced-motion probes, 0 failures  |
| Manual screenshot inspection                         | PASS on representative light/dark/narrow/reduced-motion captures |
| GitNexus detect-changes                              | LOW: 12 graph-mapped files, 36 symbols, 0 affected processes     |

Full Vitest recorded 7,795 PASS, 18 FAIL, and 12 skipped. The
failures are not hidden: 2 approved-copy assertions, 3 adapter-registry
assertions, 2 visual-rail assertions, 2 tooltip-overlay assertions, 2
MAX-authority assertions, 6 project-workspace provisioner assertions under the
full parallel run, and 1 Windows-build workflow assertion. None of those test or
implementation files is modified by this remediation. The five full-mobile
failures are likewise in the unchanged Bridge service/test pair. This handoff
therefore claims changed-scope green, not all-repository green.

The full format check identifies only the superseded old gauntlet report,
`commandEvePresentationBridge.ts`, and `seedLifecycleFetchCore.test.ts`; none is
part of this successor diff. The approved-copy drift also predates this
successor: it modifies neither locale JSON nor the manifest. Integration must
regenerate copy evidence from the combined current tree as required by the
conflict contract above.

The GitNexus MCP transport remained closed after the requested bounded retry.
The approved CLI fallback indexed the exact candidate parent. Upstream impact
for `openAndAudit` was `LOW` (one direct file caller, no mapped execution
flow). Final staged CLI `detect-changes` is also `LOW`: 12 graph-mapped files,
36 changed symbols, and 0 affected execution processes. Binary screenshots and
non-symbol patch evidence are retained in Git but are not Codegraph symbols. No
MCP availability is claimed.

No source or visual result upgrades this candidate to integration, package, or
release truth.
