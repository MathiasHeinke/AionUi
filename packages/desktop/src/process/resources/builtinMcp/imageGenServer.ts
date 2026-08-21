/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server for image generation.
 * Runs as a standalone stdio process spawned by the MCP client.
 * Reads provider config from environment variables.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { BUILTIN_IMAGE_GEN_ID, BUILTIN_IMAGE_GEN_NAME } from './constants';
import { readCommandEveManagedImageRequestId } from './managedImageRequestIdentityCore';
import { executeImageGeneration } from '@/common/chat/imageGenCore';
import { COMMAND_EVE_MANAGED_IMAGE_PLATFORM } from '@/common/config/eveManagedImageGenerationCore';
import type { TProviderWithModel } from '@/common/config/storage';
import { NodePlatformServices } from '@/common/platform/NodePlatformServices';
import { registerPlatformServices } from '@/common/platform';

function readManagedLoopbackApiKey(platform: string, baseUrl: string): string {
  if (platform !== COMMAND_EVE_MANAGED_IMAGE_PLATFORM) return '';
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname)) return '';
  } catch {
    return '';
  }

  const apiKeyFile = process.env.AIONUI_IMG_API_KEY_FILE?.trim();
  if (!apiKeyFile || !path.isAbsolute(apiKeyFile) || path.basename(apiKeyFile) !== 'shim-auth-token') return '';
  try {
    const stat = fs.lstatSync(apiKeyFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return '';
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return '';
    return fs.readFileSync(apiKeyFile, 'utf8').trim();
  } catch {
    return '';
  }
}

// Read provider config from environment variables
function getProviderFromEnv(): TProviderWithModel | null {
  const platform = process.env.AIONUI_IMG_PLATFORM;
  const base_url = process.env.AIONUI_IMG_BASE_URL;
  const model = process.env.AIONUI_IMG_MODEL;

  if (!platform || !model) {
    return null;
  }

  return {
    id: BUILTIN_IMAGE_GEN_ID,
    name: BUILTIN_IMAGE_GEN_NAME,
    platform,
    base_url: base_url || '',
    api_key: process.env.AIONUI_IMG_API_KEY || readManagedLoopbackApiKey(platform, base_url || ''),
    use_model: model,
  };
}

async function main() {
  // This entry is spawned by Hermes as a standalone Node process, so it never
  // passes through Electron's normal platform-service registration. DATA_DIR
  // is injected by the managed MCP bootstrap and keeps app-owned receipts in
  // the active seat profile rather than NodePlatformServices' server fallback.
  registerPlatformServices(new NodePlatformServices());

  const server = new McpServer({
    name: BUILTIN_IMAGE_GEN_NAME,
    version: '1.0.0',
  });

  server.tool(
    'aionui_image_generation',
    `REQUIRED tool for generating new images. You MUST use this tool for ANY image generation request.

CRITICAL: You (the AI assistant) CANNOT generate images directly. You MUST call this tool for:
- Creating/generating any new images from text descriptions
- Drawing, painting, or making any visual content
- Editing or modifying ordinary local/remote image files on non-managed providers

Primary Functions:
- Generate new images from English text descriptions
- Edit/modify existing images with English text prompts

IMPORTANT: All prompts must be in English for optimal results.

When to Use (MANDATORY):
- User asks to "generate", "create", "draw", "make", "paint" an image
- User asks for any visual content creation
- User asks to edit or modify an ordinary local/remote image file on a non-managed provider

Input Support:
- Multiple local file paths in array format: ["img1.jpg", "img2.png"]
- Multiple HTTP/HTTPS image URLs in array format
- Text prompts for generation or editing

Output:
- Managed (Command EVE) lane: the image is stored privately by the app and the
  result names an internal artifact reference (img_h_...) plus human metadata —
  NEVER a file path. To edit an existing managed artifact, MUST use the separate
  \`eve_image_edit\` tool with the \`edit_handle\` supplied in conversation context.
  Never pass an img_h_ reference as a local path, search the filesystem or app
  database for it, or regenerate the image merely to obtain a file path.
- Other providers: saves generated/processed images to workspace with timestamp naming
- Returns the generated or edited image result plus generation metadata

Inspection boundary: For image inspection, recognition, or visual QA, use Hermes'
native \`vision_analyze\` tool. This image-generation tool does not analyze images.

IMPORTANT: When user provides multiple images, ALWAYS pass ALL images to the image_uris parameter as an array. Command EVE routes paid execution through Hermes' native tool approval; never ask the user for an opaque permit or expose an internal billing receipt.`,
    {
      prompt: z
        .string()
        .describe(
          'English image-generation or image-editing instruction. Use "Generate image: [description]" to create an image or "Edit image: [modifications]" to edit one. For inspection or visual QA, use Hermes vision_analyze instead.'
        ),
      image_uris: z
        .array(z.string())
        .optional()
        .describe(
          'Optional: Array of paths to existing local image files or HTTP/HTTPS URLs to edit/modify. Examples: ["test.jpg", "https://example.com/img.png"]. For single image, use array format: ["test.jpg"].'
        ),
      aspect_ratio: z
        .enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])
        .optional()
        .describe('Optional output aspect ratio. Use 16:9 for slide directions and desktop website hero directions.'),
      resolution: z
        .enum(['1K', '2K'])
        .optional()
        .describe(
          'Optional output resolution. Use 1K for selection drafts and 2K only for a user-selected final direction.'
        ),
      workspace_dir: z
        .string()
        .optional()
        .describe(
          'Non-managed providers only: working directory for resolving relative paths and saving output images. The Command EVE managed lane ignores this value, returns an internal artifact, and uses native artifact export when the user wants a file.'
        ),
    },
    async ({ prompt, image_uris, aspect_ratio, resolution, workspace_dir }, extra) => {
      const provider = getProviderFromEnv();
      if (!provider) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Image generation model not configured. Please select an image generation model in Settings > Tools.',
            },
          ],
          isError: true,
        };
      }

      const managedRequestId =
        provider.platform === COMMAND_EVE_MANAGED_IMAGE_PLATFORM
          ? readCommandEveManagedImageRequestId(extra._meta)
          : undefined;
      if (provider.platform === COMMAND_EVE_MANAGED_IMAGE_PLATFORM && !managedRequestId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Managed image generation requires a Hermes tool-call identity.',
            },
          ],
          isError: true,
        };
      }

      const proxy = process.env.AIONUI_IMG_PROXY || undefined;
      const workspaceDir = workspace_dir || process.cwd();

      const result = await executeImageGeneration(
        { prompt, image_uris, aspect_ratio, resolution, managedRequestId },
        provider,
        workspaceDir,
        proxy
      );

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: result.text }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: result.text }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[ImageGenMCP] Fatal error:', error);
  process.exit(1);
});
