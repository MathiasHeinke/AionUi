# Command EVE Windows Pilot Environment

Status: `PHASE_A_SUPPORT_POLICY_FROZEN`
Date: 2026-07-14
Scope: unsigned Windows x64 proof and later named-pilot intake

This report is intentionally publishable. It contains no operator name, machine
identifier, account identifier, private path, customer document, credential or
network secret.

## Phase A Proof Environment

| Field | Required truth | Evidence state |
|---|---|---|
| Operating system | Windows 11 x64; GitHub `windows-2022` or newer clean runner | confirmed runner target |
| Architecture | x64 only | frozen |
| User rights | Standard-user install and runtime; no permanent elevation | frozen |
| Memory | 8 GB minimum proof target; 16 GB recommended for pilot use | frozen |
| Free disk | 15 GB before install and test evidence capture | frozen |
| Browser | Current Chrome or Edge for activation and external links | frozen |
| Endpoint protection | Microsoft Defender enabled | frozen |
| Proxy and VPN | Direct HTTPS baseline; managed proxy/VPN is outside Phase A | explicit support boundary |
| Microphone and speaker | Not required for Phase A | deferred to voice gate |
| OneDrive and network shares | Not required for Phase A | deferred to file-semantics gate |
| Local model runtime | Disabled | frozen |
| Cloud model route | Managed server-side EVE inference only | frozen |
| Provider credentials | No provider key or reusable service credential in installer, app files, logs or client-readable config | frozen hard gate |

The Phase A VM is disposable. Every candidate starts from a fresh image and is
destroyed after evidence collection. A patched VM or manually modified artifact
cannot satisfy the convergence gate.

## Named Pilot Intake

The future named pilot is known to use Windows, but the following machine and
policy facts have not yet been collected. They are `UNKNOWN_WITH_OWNER`, owned
by CPO before the named-pilot gate, and are not assumptions in Phase A:

| Field | Current state | Owner / decision point |
|---|---|---|
| Windows edition and exact build | unknown | CPO before pilot installation |
| CPU, RAM and free disk | unknown | CPO before pilot installation |
| Local admin or software-install policy | unknown | CPO before pilot installation |
| Defender or third-party endpoint policy | unknown | CPO before pilot installation |
| Proxy, VPN or TLS inspection | unknown | CPO before pilot installation |
| Chrome/Edge version | unknown | CPO before pilot installation |
| OneDrive and network-share usage | unknown | CPO before file pilot |
| Microphone and speaker availability | unknown | CPO before voice pilot |
| Update and rollback restrictions | unknown | CPO before signed pilot release |

No production or sensitive customer data is permitted in the first pilot run.

## Synthetic Pilot Tasks

The named pilot acceptance script will use synthetic or non-sensitive inputs:

1. Activate a dedicated test seat and verify the paid-credit state.
2. Ask EVE a deterministic business question and receive a complete response.
3. Attach a synthetic document and create a visible chat artifact.
4. Stop and restart a bounded task without losing conversation state.
5. Close, relaunch and verify that the task history and generated artifact remain usable.

Phase A proves tasks 1 and 2 plus installation lifecycle. Tasks 3-5 remain
later pilot gates and are not implied by the unsigned x64 proof.

## Rollback And Contact Boundary

- Stop the app and terminate only processes owned by the Command EVE run.
- Uninstall through the registered Command EVE uninstaller.
- Preserve user data unless the operator explicitly chooses a managed-profile wipe.
- Do not repair the pilot machine by hand to make an eval pass.
- A failed mandatory gate blocks promotion and creates a bounded remediation item.
- Public distribution, signing and updater-feed promotion remain outside Phase A.

## WIN-000 Verdict

`PASS_FOR_PHASE_A`: the proof environment and support boundary are fully
specified. Named-pilot machine details remain an owned later intake and cannot
be represented as confirmed facts.

Completion sentinel: `WIN_STATE_TRUTH_COMPLETE`
