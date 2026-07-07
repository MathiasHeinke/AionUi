# Command EVE Grok/xAI Multimodal Contract

Date: 2026-07-07
Status: 1.7.x contract slice, no deploy yet

## Decision

Grok/xAI is worth bringing into the 1.7.x build series as a gated multimodal
provider lane, but not as a direct provider key in the desktop app.

The product contract is:

- Desktop holds only the CEVE license bearer, never an xAI/OpenRouter/provider
  key.
- Every desktop call site must explicitly attest that no provider key is present;
  missing attestation blocks the lane.
- All managed xAI calls go through a server-side `eve-multimodal` gateway.
- Realtime voice uses server-minted ephemeral tokens only.
- Local-only, EU-cloud, and DE-cloud privacy modes block the current xAI lane
  until a matching residency route exists.
- Cloud-auto may proceed only with a server-side confirmation that the effective
  route is the advertised US cloud lane; the desktop does not silently infer it.
- Generated image/video/audio must return artifact metadata that the chat can
  render inline.
- "Smart Plus" may become a visible low-refusal discussion mode, but not a
  hidden uncensor prompt and not an external-action bypass.

## Current xAI Surface

Official xAI docs currently position:

- `grok-4.3` for general text/vision work, with 1M context and configurable
  reasoning.
- Grok Voice API for realtime speech, TTS, and STT.
- Grok Imagine API for image and video generation.
- TTS endpoint `/v1/tts`, default voice `eve`, max text length 15,000 chars,
  raw audio response.
- Voice-model contract ids for TTS/STT stay provisional until the server gateway
  binds them to the exact xAI endpoint payload; the desktop contract treats them
  as lane labels, not client-callable model ids.
- Video generation endpoint `/v1/videos/generations`, async poll by request id,
  1-15 second duration.
- Ephemeral tokens for client-side realtime voice; docs explicitly say to never
  expose the API key in browser/mobile clients.

Sources:

- <https://docs.x.ai/developers/models>
- <https://docs.x.ai/developers/model-capabilities/audio/text-to-speech>
- <https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens>
- <https://docs.x.ai/developers/model-capabilities/video/generation>
- <https://docs.x.ai/developers/models/grok-imagine-image-quality>

## Why 1.7.x

This belongs in 1.7.x because the adjacent surfaces are already landing:

- artifact cards now render generated image/video/audio/HTML/file outputs
- STT send flow is wired
- local read-aloud exists behind a service seam
- privacy/egress controls are already prominent in the chat header

The next missing piece is provider routing and gateway hardening, not another UI
surface.

## First Code Contract

The first code slice is pure and fail-closed:

- `packages/desktop/src/common/config/eveMultimodalGatewayCore.ts`
- `tests/unit/command-eve/eveMultimodalGatewayCore.test.ts`

It defines:

- capabilities: `vision`, `image_generation`, `video_generation`, `tts`, `stt`,
  `realtime_voice`
- endpoint kinds: `responses`, `image_generation`, `video_generation_async`,
  `tts_binary`, `stt_binary`, `realtime_ephemeral`
- artifact kinds: `text`, `image`, `video`, `audio`
- provider residency: current xAI lane is `us_cloud`
- hard blocks for:
  - direct provider key in desktop
  - missing no-desktop-provider-key attestation
  - missing server gateway
  - missing CEVE license
  - local-only privacy
  - EU/DE residency requests until a matching provider route exists
- `cloud_auto` returns `server-must-confirm-us-cloud` so the gateway has to
  resolve and record the effective residency before dispatch.
- STT/vision input is bounded at 20 MiB in the desktop contract until the gateway
  applies stricter endpoint-specific limits.

No runtime call is enabled by this slice.

## Follow-Up Build Order

1. Add and deploy `eve-multimodal` Edge Function skeleton with license auth,
   no provider call yet.
2. Add server-side secret config for `XAI_API_KEY`; verify no desktop bundle
   contains it.
3. Implement TTS first because the chat already has local read-aloud and audio
   artifact rendering.
4. Implement image/video through the artifact contract; video must be async and
   return progress/failure states.
5. Implement vision only behind the privacy tab because image upload is high
   trust/PII sensitive.
6. Realtime voice last, because it needs ephemeral-token issuance and websocket
   session lifecycle controls.
