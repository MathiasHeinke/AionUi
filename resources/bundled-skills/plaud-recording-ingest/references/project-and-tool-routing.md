# Project and Tool Routing Contract

Use this reference when a recording should become project knowledge, project
work, or a connector action.

## Separate four layers

Keep these layers independent:

1. Source recording: immutable PLAUD identity and private audio.
2. Conversation artifacts: transcript, summary, decisions, questions.
3. Project projection: approved copies or references inside one selected
   project.
4. Tool actions: proposed task, mail, calendar, CRM, or publishing operations.

Never treat a summary as an executed task or a mail draft as a sent message.

## Resolve the target project

Use this precedence:

1. Active Command EVE project or seat context.
2. Existing local mapping from recording source or folder to a project.
3. Explicit project selected by the user.
4. Private conversation inbox with `project_status: unassigned`.

Do not infer the destination from private transcript content with an online
model. A local classifier may propose a destination, but the proposal must show
its evidence and remain reversible.

Command EVE must pass its fixed, seat-scoped project root to the publishing
script. A model never chooses an arbitrary application data path.

## Default project surface

Use this project-local layout unless the project already defines another
approved conversation folder:

```text
<project-root>/docs/conversations/<YYYY-MM-DD>/<plaud-file-id>/
  recording.json
  summary.md
  decisions.md
  open-questions.md
  actions.json
  transcript.txt        # optional
```

Keep source audio in private application storage. Copy it into a project only
after an explicit request and retention decision.

`docs/conversations` is the durable human-readable project surface. Command
EVE should render these artifacts in the normal project interface. Store
redacted machine receipts under the existing `.command-eve/receipts` surface;
do not create a competing `.eve` namespace.

## Artifact rules

- Publish by immutable PLAUD file ID plus SHA-256.
- Use `0700` directories and `0600` files.
- Reject symlinks and path traversal.
- Never overwrite a different artifact silently.
- Record source and destination hashes.
- Preserve timestamp evidence in summaries, decisions, questions, and actions.
- Keep raw transcript, cleaned transcript, and synthesis distinct.

## Action proposal schema

Store proposals in `actions.json`:

```json
{
  "schema_version": 1,
  "source_file_id": "immutable-plaud-id",
  "proposals": [
    {
      "id": "stable-local-id",
      "kind": "gmail.draft",
      "status": "proposed",
      "payload": {
        "to": [],
        "subject": null,
        "body_artifact": "follow-up-email.md"
      },
      "evidence": {
        "start_seconds": 0,
        "end_seconds": 0,
        "confidence": "medium"
      },
      "external_write_status": "not_requested"
    }
  ]
}
```

Allowed proposal kinds include:

- `task.create`
- `gmail.draft`
- `calendar.draft`
- `project.note`
- `crm.update_draft`

Extend the list only through an explicit connector policy. Do not encode raw
credentials or destination tokens.

## Gmail boundary

Derive an email only when the user asks for a follow-up or the local synthesis
creates a visible proposal. Then:

1. Generate a local `follow-up-email.md` draft grounded in timestamp evidence.
2. Resolve recipients from confirmed project contacts or ask the user. Never
   infer an address from a voice.
3. Present recipient, subject, and body for approval.
4. Use the connected Gmail tool to create a draft only after approval.
5. Send only after a second explicit send instruction.
6. Record the connector receipt in the project without storing credentials.

If Gmail is unavailable, keep the local draft and report
`blocked_connector`. Do not change the content route merely to reach Gmail.

## Task and calendar boundary

Create a task proposal only when the recording establishes a concrete action.
Do not infer owner or due date. Create external tasks or calendar events only
after the user approves the exact proposal and destination.

## Multiple projects

Do not duplicate one conversation across several projects by default. Publish
to one primary project, then create explicit cross-project references when the
user approves them. Each projection must retain the same source identity and
artifact hashes.
