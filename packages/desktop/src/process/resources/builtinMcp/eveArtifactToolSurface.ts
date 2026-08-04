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

export const EVE_ARTIFACT_TOOL_ARTIFACT_GET = 'eve_artifact_get';
export const EVE_ARTIFACT_TOOL_ARTIFACT_LIST = 'eve_artifact_list';
export const EVE_ARTIFACT_TOOL_VIDEO_EDIT = 'eve_video_edit';
export const EVE_ARTIFACT_TOOL_IMAGE_EDIT = 'eve_image_edit';

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
  const surface = [ARTIFACT_GET, ARTIFACT_LIST];
  if (isAgentVideoEditEnabled(env)) surface.push(VIDEO_EDIT);
  // 1.820.3 — the image half. Its OWN flag carrier (`agentImageEditFlag.ts`):
  // the two paid tools are advertised independently, so kill-switching one
  // medium never darkens the other.
  if (isAgentImageEditEnabled(env)) surface.push(IMAGE_EDIT);
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
