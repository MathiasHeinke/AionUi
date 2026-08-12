/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 POLICY F — WHICH artifact tools a seat is allowed to be told about.
 *
 * Round 1 gated the context envelope and reported this policy met. It had gated
 * one of two surfaces. The MCP server registered `eve_video_edit`
 * unconditionally, so the tool list Hermes publishes advertised a paid
 * capability to the model on every seat, including seats where the spending
 * path is closed and the app would refuse the call.
 *
 * That is not a cosmetic mismatch:
 *
 *   - an advertised tool is an instruction. A model that sees `eve_video_edit`
 *     will call it, be refused, and try again in a different wording, because
 *     from where it sits a refusal reads as a mistake it made;
 *   - it puts an offer in the transcript that the product does not honour, which
 *     is the same class of dishonesty as a button that does nothing;
 *   - and it makes the gate look decorative to anyone reading the tool list,
 *     which is how a closed feature quietly becomes an open one.
 *
 * So the decision lives HERE, in one testable place, and both the MCP entry
 * point and the config that spawns it read from it. The entry point cannot be
 * imported by a test — it connects a stdio transport on import — which is
 * exactly why the decision must not live inside it.
 *
 * WHAT THE ENV MEANS HERE, post-1.820.2: this module runs in the MCP CHILD,
 * which cannot read the licence wire and must not try. Main resolves
 * eligibility once (`agentVideoEditFlag.ts`: default-ON for an eligible seat,
 * `'0'` kill-switch, no wire fails closed) and emits exactly `'1'` into this
 * process's environment when — and only when — the seat may be told about the
 * paid tool. The exact-`'1'` read below is therefore not the eligibility check;
 * it is the carrier of one already made.
 *
 * PURE: no fs, no network, no SDK. Takes an env object, returns descriptors.
 */

import { isAgentVideoEditEnabled } from '@process/commandEve/agentVideoEditFlag';
import { isAgentImageEditEnabled } from '@process/commandEve/agentImageEditFlag';
import { isAgentVideoGenerateEnabled } from '@process/commandEve/agentVideoGenerateFlag';

export const EVE_ARTIFACT_TOOL_ARTIFACT_GET = 'eve_artifact_get';
export const EVE_ARTIFACT_TOOL_ARTIFACT_LIST = 'eve_artifact_list';
export const EVE_ARTIFACT_TOOL_VIDEO_EDIT = 'eve_video_edit';
export const EVE_ARTIFACT_TOOL_IMAGE_EDIT = 'eve_image_edit';
export const EVE_ARTIFACT_TOOL_VIDEO_GENERATE = 'eve_video_generate';
export const EVE_ARTIFACT_TOOL_TYPED_UI_PUBLISH = 'eve_typed_ui_publish';

export interface EveArtifactToolDescriptor {
  name: string;
  description: string;
  /** True when invoking it can cost the user money. Exactly one tool is. */
  spends: boolean;
}

const ARTIFACT_GET: EveArtifactToolDescriptor = {
  name: EVE_ARTIFACT_TOOL_ARTIFACT_GET,
  description:
    'Read what Command EVE knows about ONE artifact the user already has, by its capability handle. Returns its kind, length and whether it can be edited. Costs nothing and changes nothing.',
  spends: false,
};

const ARTIFACT_LIST: EveArtifactToolDescriptor = {
  name: EVE_ARTIFACT_TOOL_ARTIFACT_LIST,
  description:
    'Read several artifacts at once, by the capability handles from your context. There is deliberately no way to list a conversation by id: a handle is the only thing that proves you were given the artifact.',
  spends: false,
};

const TYPED_UI_PUBLISH: EveArtifactToolDescriptor = {
  name: EVE_ARTIFACT_TOOL_TYPED_UI_PUBLISH,
  description:
    'Publish one declarative Command EVE Typed UI envelope. The app validates the fixed schema and 45-component catalog and returns a renderable artifact. This cannot run JavaScript, CSS, HTML, shell, IPC or network actions.',
  spends: false,
};

const VIDEO_EDIT: EveArtifactToolDescriptor = {
  name: EVE_ARTIFACT_TOOL_VIDEO_EDIT,
  description:
    'Edit a video the user already has. Takes the capability handle for the SOURCE clip, the single-use spend permit from this request, and a plain instruction ("give the aubergine a face"). The result is a NEW video saved beside the original — the original is never overwritten. Quality and length are inherited from the source and cannot be chosen. This spends the user\'s credits, ONCE: the permit is consumed, and a second edit — including a different variation of the same one — needs the user to ask again.',
  spends: true,
};

const IMAGE_EDIT: EveArtifactToolDescriptor = {
  name: EVE_ARTIFACT_TOOL_IMAGE_EDIT,
  description:
    'Edit an image the user already has. Takes the capability handle for the SOURCE image (an `edit_handle` from a kind=image entry in your context), the single-use image spend permit from this request, and a plain instruction ("make the sky overcast"). The result is a NEW image — the original is never overwritten — returned as a fresh staged reference (`img_h_…`) you may show the user. Quality and format are inherited from the source and cannot be chosen. This spends the user\'s credits, ONCE: the permit is consumed, and a second edit — including a different variation of the same one — needs the user to ask again.',
  spends: true,
};

/**
 * CEVE-18205 — the paid video GENERATE.
 *
 * The description says "the user asked for" out loud, and that phrasing is doing
 * real work rather than being polite. The two edit tools are bounded by a
 * single-use permit: the model may hold them and still cannot spend twice on one
 * turn. THIS tool has no such permit — `handleCommandEveVideoGenerate` takes none
 * and redeems none — so the only thing standing between it and a repeated debit
 * is what the model believes it is for. A description that reads like an
 * always-available utility invites exactly the loop we cannot yet refuse.
 *
 * It also states what the model may NOT choose. Length and quality are pinned
 * app-side against a server-owned price list the model cannot read; inviting it
 * to ask for "4K, 15 seconds" would produce a refusal it would then retry.
 */
const VIDEO_GENERATE: EveArtifactToolDescriptor = {
  name: EVE_ARTIFACT_TOOL_VIDEO_GENERATE,
  description:
    "Generate a NEW short video from a text prompt, in a conversation that already has a Command EVE artifact — pass any capability handle from your context to say which conversation. Use this ONLY when the user asked for a video in this turn; it is not a utility to call on your own initiative. Length and quality are chosen by the app and cannot be requested. This spends the user's credits EVERY time it is called, so call it once and show the result — do not retry a wording, and do not produce variations unless the user asks for another one.",
  spends: true,
};

/**
 * The tools this seat may be told about.
 *
 * The READ half is never gated. It costs nothing, cannot spend, and is the whole
 * point of the artifact envelope — gating it too would mean the feature is
 * absent in its own default state.
 *
 * The SPENDING half appears only when the env says exactly `1` — the value Main
 * emits after ITS resolver (`agentVideoEditFlag.ts`) has judged this seat
 * eligible and not kill-switched — so the tool list and the handler cannot
 * disagree about what this seat can do.
 */
export function buildEveArtifactToolSurface(env: NodeJS.ProcessEnv = process.env): EveArtifactToolDescriptor[] {
  const surface = [ARTIFACT_GET, ARTIFACT_LIST, TYPED_UI_PUBLISH];
  if (isAgentVideoEditEnabled(env)) surface.push(VIDEO_EDIT);
  // 1.820.3 — the image half. Its OWN flag carrier (`agentImageEditFlag.ts`):
  // the two paid tools are advertised independently, so kill-switching one
  // medium never darkens the other.
  if (isAgentImageEditEnabled(env)) surface.push(IMAGE_EDIT);
  // CEVE-18205 — the generate third, from ITS OWN flag carrier
  // (`agentVideoGenerateFlag.ts`), which Main emits only for a seat that opted
  // in with exactly '1'. Independent of the other two in both directions.
  if (isAgentVideoGenerateEnabled(env)) surface.push(VIDEO_GENERATE);
  return surface;
}

/**
 * Is this tool on the surface?
 *
 * A loop rather than `.some(` / `.includes(`, because this module sits on the
 * paid-edit resolution path and the structural gate over that path bans every
 * string-matching primitive outright — a ban that only stays checkable if it has
 * no exceptions.
 */
export function isToolAdvertised(surface: readonly EveArtifactToolDescriptor[], name: string): boolean {
  let found = false;
  for (const tool of surface) if (tool.name === name) found = true;
  return found;
}

/** The description for one advertised tool, or `''`. */
export function describeEveArtifactTool(surface: readonly EveArtifactToolDescriptor[], name: string): string {
  let description = '';
  for (const tool of surface) if (tool.name === name) description = tool.description;
  return description;
}
