# MAT-1843 local gate evidence

Snapshot: `sha256:1ae8099e24e0dd093fbde706cfb9da9d86e869b0c06e3725fbb991af66991437`

| Gate                          | Result                             | Evidence                                                                                                    |
| ----------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Focused/full slice Vitest     | PASS                               | 19 files, 299 tests                                                                                         |
| Remediation-focused Vitest    | PASS                               | 2 files, 46 tests                                                                                           |
| TypeScript                    | PASS                               | `bunx tsc --noEmit` exit 0                                                                                  |
| i18n generated types          | PASS                               | keys up to date                                                                                             |
| Focused remediation oxlint    | PASS                               | 0 warnings, 0 errors                                                                                        |
| Changed-source oxlint         | PASS_WITH_BASELINE_WARNINGS        | 0 errors; 9 pre-existing warnings in `ipcBridge.ts` / `commandEveBridge.ts`                                 |
| oxfmt                         | PASS                               | changed TS/TSX/CSS/JSON files formatted                                                                     |
| diff check                    | PASS                               | `git diff --check` exit 0                                                                                   |
| GitNexus final detect-changes | REVIEWED_CRITICAL_INTEGRATED_SCOPE | 46 files, 316 symbols, 36 flows; critical is the whole shared candidate, not the bounded image-edit handler |
| Multi-model route receipt     | PASS                               | `multi-model-execution/v2`, phase `reported`, source state `PASS`                                           |
| Fable 5 CAO                   | PASS                               | exact snapshot digest reproduced; remediation tests independently re-run 46/46 PASS                         |

Pre-edit GitNexus impact for `handleCommandEveImageEdit` was LOW (one direct test caller). The proposed historical artifact parser/stage migration measured HIGH and was not ignored or edited; it is parked under MAT-1845.

No packaged app, provider call, signing, notarization, R2 upload, feed publication or deployment gate ran here.
