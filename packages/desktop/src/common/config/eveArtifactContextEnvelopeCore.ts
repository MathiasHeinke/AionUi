/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 Variant C1 — the context envelope.
 *
 * The defect: managed video is a direct renderer -> IPC -> gateway call, so no
 * message is sent to the agent. The clip exists, the user can see it, and the
 * agent knows nothing about it. "Gib der Aubergine ein Gesicht" then has nothing
 * to refer to.
 *
 * The rejected fix was to create a hidden turn announcing the artifact. That
 * costs an inference call per artifact and puts words in the transcript nobody
 * said. Variant C instead RIDES the turn the user was already going to send: the
 * envelope is prepended inside the existing `[[COMMAND_EVE_PREPARED_CONTEXT]]`
 * delimiters, which `stripCommandEvePreparedContext` already removes at render
 * time. So the model sees the artifacts, and the displayed message is
 * byte-identical to what it would be WITHOUT the envelope — which is the honest
 * form of the claim, because that stripper has always trimmed leading whitespace
 * from every message it renders and still does. No extra turn, no extra spend,
 * no invented dialogue.
 *
 * WHAT THE ENVELOPE DELIBERATELY SHOWS THE MODEL. Both items below are
 * INTENTIONALLY MODEL-VISIBLE opaque capability tokens. That is the design, not
 * a leak, and it is stated first because an earlier version of this header said
 * "no credential, no bearer" while its own code emitted two:
 *
 *   - an opaque `edit_handle` per editable clip (`renderEntry`). It is a
 *     capability: it names WHICH clip and it is the only accepted way to say so.
 *     The model is SUPPOSED to hold it and quote it back — that is how a
 *     follow-up refers to a clip without a path. It cannot be forged from
 *     anything in the transcript, it is scoped to one conversation and one set
 *     of bytes, it carries read-only authority, and it expires;
 *   - at most ONE ephemeral spend permit for the whole turn, and only when a
 *     capability that could spend it is actually advertised. The model is
 *     supposed to hold this one too, for exactly as long as one turn lasts: it
 *     authorises exactly one paid edit, for this request, and it is single-use.
 *
 * Both are real authority and are bounded as such — scoped, short-lived,
 * single-purpose, revocable — rather than hidden. A capability token that the
 * model may see is the whole mechanism; the defence is what the token can DO,
 * not who can read it. (They are still redacted out of the DISPLAYED transcript,
 * the export and the support bundle, because a credential in a file the user
 * mails to support outlives the conversation it belonged to. Model-visible and
 * artefact-visible are different questions and get different answers.)
 *
 * WHAT IS FORBIDDEN ON THIS SURFACE — the actual no-list, and it is as
 * load-bearing as the yes-list above:
 *
 *   - no filesystem path of any kind. The handle is the reference. A path in the
 *     envelope is a path the model can quote back, it ships the account name to
 *     a third-party API, and the moment a path is treated as a reference "which
 *     paths are allowed" becomes a question we have to answer forever;
 *   - no provider auth, no licence wire, no session or seat authentication, no
 *     raw provider key — nothing the model could replay against a third party or
 *     against our own gateway. Unlike the two capabilities above, these are not
 *     scoped to one clip and one turn, so nothing bounds them;
 *   - no seat id and no user id — identity, not capability;
 *   - no conversation id: it is guessable, so it could never have been proof,
 *     and emitting it would only invite it to be used as one;
 *   - no base64 and no `data:` URL — one inlined clip would blow the context
 *     window, and the second one would blow the bill.
 *
 * And it is BOUNDED, by count and by characters. An unbounded envelope on a long
 * conversation is a slow context leak that gets more expensive every turn.
 *
 * PURE: no fs, no Electron, no IPC.
 */

import { collapseInlineWhitespace } from './eveOpaqueTokenCore';
import {
  buildCommandEvePreparedAgentInput,
  COMMAND_EVE_PREPARED_CONTEXT_END,
  COMMAND_EVE_PREPARED_CONTEXT_START,
  neutralizeContextBoundaries,
} from './evePreparedContextCore';

/**
 * At most this many artifacts ride along. Newest first: if a conversation has
 * produced thirty clips, the ones the user is talking about are the recent ones,
 * and silently truncating from the wrong end would drop exactly those.
 */
export const ARTIFACT_ENVELOPE_MAX_ARTIFACTS = 24;

/**
 * Hard character ceiling for the rendered envelope. Reached only by a pathological
 * conversation; when it is reached the envelope is TRUNCATED to whole entries and
 * says so, rather than emitting half a line the model would read as a fact.
 */
export const ARTIFACT_ENVELOPE_MAX_CHARS = 6_000;

export const ARTIFACT_ENVELOPE_HEADING = 'Command EVE artifact registry for this conversation.';

/** One artifact as the model may see it. Every field is here because a follow-up needs it. */
export interface EveArtifactEnvelopeEntry {
  artifactId: string;
  /**
   * `reference_image` (MAT-1753) is a file the user attached to THIS message —
   * a pending input, not a produced artifact, and the exact thing a
   * reference-to-video render would use. It rides this envelope rather than a
   * surface of its own for the reason item C names: those files ARE what the
   * user is looking at, so the agent must see exactly them, and no second picker
   * may exist to disagree.
   *
   * `image` (MAT-1769) is an image the user attached to an EARLIER message of
   * this conversation, re-listed from Main's durable record so a follow-up
   * ("das Bild") resolves the latest visible image without reattachment.
   * Newest first, never editable, no handle.
   */
  kind: 'video' | 'reference_image' | 'image';
  mimeType: string;
  durationSeconds: number;
  editable: boolean;
  /**
   * The opaque capability handle for editing this artifact, when one exists.
   * Absent for a clip that is not editable — a handle is minted only for an
   * artifact that has already passed the ceiling and tier checks, so its
   * presence IS the statement that an edit is allowed.
   */
  editHandle?: string;
  /**
   * The SHA-256 of the artifact bytes. Carried so the send path can bind THIS
   * turn's spend permit to exactly the clips the model was shown, and
   * deliberately NOT rendered into the envelope: a hash the model can quote back
   * is one more thing that would have to be treated as untrusted at redeem.
   */
  artifactSha256?: string;
  parentArtifactId?: string;
  /** True when this artifact is part of the user's active selection. */
  selected?: boolean;
}

export interface EveArtifactContextEnvelopeInput {
  entries: readonly EveArtifactEnvelopeEntry[];
  /**
   * The capabilities this seat may actually invoke right now.
   *
   * `eve_video_edit` belongs here ONLY when the paid path is genuinely enabled.
   * Advertising a capability that is switched off pre-arms every transcript with
   * an offer the app will refuse, and teaches the model to keep trying a door
   * that will never open on its own.
   */
  allowedCapabilities: readonly string[];
  /**
   * The ephemeral single-use spend permit for THIS turn, when one was minted.
   *
   * Emitted only alongside an enabled paid capability. Absent on every read-only
   * turn, which is the common case — so an ordinary conversation carries no
   * spending credential at all.
   */
  spendPermit?: string;
}

function scalar(value: string): string {
  // `collapseInlineWhitespace` rather than a regex replace: the semantic gate
  // over this path bans regular expressions outright, because a structural test
  // cannot tell a sanitiser from a classifier.
  return collapseInlineWhitespace(neutralizeContextBoundaries(value)).trim().slice(0, 200);
}

function numeric(value: number): string {
  return Number.isFinite(value) && value >= 0 ? String(Math.round(value * 100) / 100) : '0';
}

function renderEntry(entry: EveArtifactEnvelopeEntry): string {
  const fields = [
    `artifact_id=${scalar(entry.artifactId)}`,
    `kind=${scalar(entry.kind)}`,
    `mime=${scalar(entry.mimeType)}`,
    `duration_seconds=${numeric(entry.durationSeconds)}`,
    `editable=${entry.editable ? 'true' : 'false'}`,
  ];
  if (entry.parentArtifactId) fields.push(`edited_from=${scalar(entry.parentArtifactId)}`);
  if (entry.selected) fields.push('selected=true');
  // The handle goes LAST and only when the artifact is editable. An editable
  // flag without a handle would be an offer we cannot honour; a handle on a
  // non-editable clip would be authority we already decided not to grant.
  if (entry.editable && entry.editHandle) fields.push(`edit_handle=${scalar(entry.editHandle)}`);
  return `- ${fields.join(' ')}`;
}

/**
 * Render the envelope body, or `''` when there is nothing to say.
 *
 * An empty string is meaningful: it means the turn carries NO envelope at all,
 * so a conversation that has produced no artifacts costs exactly what it costs
 * today. The feature is invisible until it has something true to contribute.
 */
export function buildEveArtifactContextEnvelope(input: EveArtifactContextEnvelopeInput): string {
  const entries = input.entries.slice(0, ARTIFACT_ENVELOPE_MAX_ARTIFACTS);
  if (entries.length === 0) return '';

  const capabilities = input.allowedCapabilities.map(scalar).filter(Boolean);
  // The permit is emitted only when a capability that can spend it is actually
  // advertised. A permit with no enabled capability is a live spending
  // credential sitting in a transcript for no reason at all.
  const spendPermit = capabilities.length > 0 && input.spendPermit ? scalar(input.spendPermit) : '';
  const header = [
    ARTIFACT_ENVELOPE_HEADING,
    'These artifacts already exist. They were produced by the app, not by you, and they are real.',
    'Entries with kind=reference_image are files the user attached to THIS message. They are',
    'inputs — usable as reference images for a video — not clips that exist yet: there is nothing to',
    'play and no handle to pass. Do not ask the user to pick them again; they are already chosen.',
    'Entries with kind=image are images the user sent with an earlier message, NEWEST first:',
    '"the image" / "das Bild" means the first of them unless the user says otherwise. They are',
    'already part of this conversation — never ask the user to re-attach one.',
    'To act on a clip, pass its `edit_handle` verbatim to the matching tool. The handle names WHICH clip:',
    'never substitute an artifact_id, a filename, a conversation id or a guess for it.',
    'An artifact without an `edit_handle` cannot be edited; say so rather than attempting it.',
    capabilities.length > 0
      ? `Allowed capabilities on this seat: ${capabilities.join(', ')}.`
      : // Said explicitly rather than left to inference. `editable=true`
        // describes the CLIP — it passed the length and tier checks — and with
        // no capability enabled it is not an action that can be taken. A model
        // that reads "editable" as "you may edit" and tries would be right about
        // the word and wrong about the seat.
        'No artifact capabilities are enabled on this seat right now. `editable` describes the clip, not something you can do.',
    ...(spendPermit
      ? [
          // Said plainly, because the model's behaviour is what enforces the
          // user's intent here: the permit covers ONE paid edit for THIS
          // request. A second edit needs the person to ask for a second edit.
          `This request carries ONE spend permit: ${spendPermit}`,
          'It authorises exactly ONE paid edit, for this request only, and it expires in minutes.',
          'Pass it as `permit` together with the `edit_handle`. Do not reuse it, do not try a second',
          'variation with it, and do not repeat it back to the user — a second edit needs a new request',
          'from them.',
        ]
      : []),
    '',
  ];

  const lines: string[] = [];
  let used = header.join('\n').length;
  let truncated = false;
  for (const entry of entries) {
    const rendered = renderEntry(entry);
    if (used + rendered.length + 1 > ARTIFACT_ENVELOPE_MAX_CHARS) {
      truncated = true;
      break;
    }
    lines.push(rendered);
    used += rendered.length + 1;
  }

  // Nothing fit. Emitting a header that promises a registry and then lists
  // nothing would be worse than staying silent.
  if (lines.length === 0) return '';
  if (truncated) lines.push('- (older artifacts omitted; ask the user to name the clip if it is not listed)');
  return [...header, ...lines].join('\n');
}

/**
 * Compose the string the agent actually receives for a turn.
 *
 * `buildCommandEvePreparedAgentInput` is left completely untouched — it carries
 * a file-analysis routing contract that must NOT fire on an ordinary turn, and
 * an upstream impact check rates it HIGH. (It now has exactly one production
 * caller: this function. The ACP send path reaches it only through here, which
 * is the point — one composition site rather than two shapes of turn input.)
 * So the artifact envelope is emitted as its OWN block ahead of it,
 * with the same delimiters, and the existing `stripCommandEvePreparedContext`
 * already loops over every block — which is why the displayed message stays
 * byte-identical to what it would be WITHOUT the envelope, with no change to the
 * renderer. (Not "to what the user typed", which is the wording the header of
 * this file already corrects: `stripCommandEvePreparedContext` has always
 * `trimStart`ed every message it renders. Leaving the looser sentence here
 * would have this file contradicting its own header.)
 *
 * What DOES reach the agent byte-for-byte is `userInput`: it is appended last
 * and untouched, which is what lets the ordinary-turn spend permit bind the very
 * bytes the model reads. See `AcpSendBox.tsx` at the `userTurnText` call site.
 *
 * Order is deliberate: artifacts first (they describe the world), prepared
 * evidence second (it describes an attachment), the user's words last, because
 * the last thing a model reads is the thing it answers.
 */
export function buildCommandEveAgentTurnInput(input: {
  userInput: string;
  preparedContext?: string;
  artifactEnvelope?: string;
}): string {
  const base = buildCommandEvePreparedAgentInput(input.userInput, input.preparedContext);
  const envelope = input.artifactEnvelope?.trim();
  if (!envelope) return base;
  return [COMMAND_EVE_PREPARED_CONTEXT_START, envelope, COMMAND_EVE_PREPARED_CONTEXT_END, base].join('\n');
}
