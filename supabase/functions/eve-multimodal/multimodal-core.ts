// Command EVE — eve-multimodal gateway core (pure).
//
// This is the server-side skeleton contract for xAI/Grok multimodal work. It is
// intentionally not a provider client yet: successful auth + request validation
// still returns provider-not-enabled so no xAI call can accidentally ship before
// the gateway has residency, cost, artifact, and timeout controls.

export type EveMultimodalCapability =
  | "vision"
  | "image_generation"
  | "video_generation"
  | "tts"
  | "stt"
  | "realtime_voice";

export type EveMultimodalPrivacyLane =
  | "local_only"
  | "cloud_auto"
  | "cloud_us"
  | "cloud_eu"
  | "cloud_de";

export type EveMultimodalArtifactKind = "text" | "image" | "video" | "audio";

export type EveMultimodalReason =
  | "invalid-request"
  | "provider-key-field"
  | "desktop-provider-key-present"
  | "unsupported-capability"
  | "local-only-privacy"
  | "residency-unavailable"
  | "provider-not-enabled";

export type EveMultimodalRequestBody = {
  provider?: string;
  capability?: string;
  privacyLane?: string;
  directProviderKeyPresentInDesktop?: unknown;
  requestId?: string;
};

export type EveMultimodalResidencyReceipt = {
  requestedPrivacyLane: EveMultimodalPrivacyLane;
  effectiveResidency: "us_cloud";
  confirmation: "explicit-us-cloud" | "server-must-confirm-us-cloud";
};

export type EveMultimodalArtifactEnvelope = {
  status: "not_created";
  kind: EveMultimodalArtifactKind;
};

export type EveMultimodalSkeletonResponse = {
  ok: false;
  gateway: "eve-multimodal";
  provider: "xai";
  reason: EveMultimodalReason;
  message: string;
  checked_at: string;
  request_id: string;
  capability?: EveMultimodalCapability;
  residency?: EveMultimodalResidencyReceipt;
  artifact?: EveMultimodalArtifactEnvelope;
  license?: { verified: true; edition: string };
};

export type EveMultimodalDecision = {
  status: number;
  body: EveMultimodalSkeletonResponse;
};

export type DecideEveMultimodalArgs = {
  body: unknown;
  now: string;
  requestId: string;
};

const CAPABILITIES = Object.freeze(
  [
    "vision",
    "image_generation",
    "video_generation",
    "tts",
    "stt",
    "realtime_voice",
  ] as const,
);

const PRIVACY_LANES = Object.freeze(
  [
    "local_only",
    "cloud_auto",
    "cloud_us",
    "cloud_eu",
    "cloud_de",
  ] as const,
);

const ARTIFACT_BY_CAPABILITY: Record<
  EveMultimodalCapability,
  EveMultimodalArtifactKind
> = {
  vision: "text",
  image_generation: "image",
  video_generation: "video",
  tts: "audio",
  stt: "text",
  realtime_voice: "audio",
};

const FORBIDDEN_PROVIDER_KEY_FIELDS = new Set([
  "apiKey",
  "api_key",
  "authorization",
  "openrouter-api-key",
  "openrouterApiKey",
  "openrouter_api_key",
  "provider-key",
  "providerKey",
  "provider_key",
  "xai-api-key",
  "xaiApiKey",
  "xai_api_key",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCapability(value: unknown): value is EveMultimodalCapability {
  return typeof value === "string" &&
    (CAPABILITIES as readonly string[]).includes(value);
}

function isPrivacyLane(value: unknown): value is EveMultimodalPrivacyLane {
  return typeof value === "string" &&
    (PRIVACY_LANES as readonly string[]).includes(value);
}

function containsForbiddenProviderKeyField(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (Array.isArray(value)) {
    return value.some((entry) =>
      containsForbiddenProviderKeyField(entry, depth + 1)
    );
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    return FORBIDDEN_PROVIDER_KEY_FIELDS.has(key) ||
      FORBIDDEN_PROVIDER_KEY_FIELDS.has(key.toLowerCase()) ||
      containsForbiddenProviderKeyField(nested, depth + 1);
  });
}

function response(
  status: number,
  reason: EveMultimodalReason,
  message: string,
  args: DecideEveMultimodalArgs,
  extra: Partial<
    Pick<EveMultimodalSkeletonResponse, "capability" | "residency" | "artifact">
  > = {},
): EveMultimodalDecision {
  return {
    status,
    body: {
      ok: false,
      gateway: "eve-multimodal",
      provider: "xai",
      reason,
      message,
      checked_at: args.now,
      request_id: args.requestId,
      ...extra,
    },
  };
}

function residencyReceipt(
  privacyLane: EveMultimodalPrivacyLane,
): EveMultimodalResidencyReceipt {
  return {
    requestedPrivacyLane: privacyLane,
    effectiveResidency: "us_cloud",
    confirmation: privacyLane === "cloud_auto"
      ? "server-must-confirm-us-cloud"
      : "explicit-us-cloud",
  };
}

export function decideEveMultimodalSkeletonRequest(
  args: DecideEveMultimodalArgs,
): EveMultimodalDecision {
  if (!isRecord(args.body)) {
    return response(
      400,
      "invalid-request",
      "eve-multimodal requires a JSON object request body.",
      args,
    );
  }

  if (containsForbiddenProviderKeyField(args.body)) {
    return response(
      400,
      "provider-key-field",
      "Provider API keys must never be sent to eve-multimodal.",
      args,
    );
  }

  const provider = args.body.provider ?? "xai";
  if (provider !== "xai" || !isCapability(args.body.capability)) {
    return response(
      400,
      "unsupported-capability",
      "Unsupported eve-multimodal provider or capability.",
      args,
    );
  }

  const capability = args.body.capability;
  const privacyLane = args.body.privacyLane === undefined
    ? "cloud_auto"
    : isPrivacyLane(args.body.privacyLane)
    ? args.body.privacyLane
    : null;
  if (privacyLane === null) {
    return response(
      400,
      "invalid-request",
      "Unknown privacyLane. Valid lanes: local_only, cloud_auto, cloud_us, cloud_eu, cloud_de.",
      args,
      { capability },
    );
  }
  const base = {
    capability,
    artifact: {
      status: "not_created",
      kind: ARTIFACT_BY_CAPABILITY[capability],
    },
  } satisfies Partial<
    Pick<EveMultimodalSkeletonResponse, "capability" | "artifact">
  >;

  if (args.body.directProviderKeyPresentInDesktop !== false) {
    return response(
      400,
      "desktop-provider-key-present",
      "Desktop must explicitly attest that no provider key is bundled before the gateway can run.",
      args,
      base,
    );
  }

  if (privacyLane === "local_only") {
    return response(
      403,
      "local-only-privacy",
      "xAI multimodal is blocked while local-only privacy mode is active.",
      args,
      base,
    );
  }

  if (privacyLane === "cloud_eu" || privacyLane === "cloud_de") {
    return response(
      403,
      "residency-unavailable",
      "xAI multimodal is currently available only as a US cloud lane in this gateway.",
      args,
      base,
    );
  }

  return response(
    501,
    "provider-not-enabled",
    "eve-multimodal gateway is deployed but provider execution is not enabled yet.",
    args,
    {
      ...base,
      residency: residencyReceipt(privacyLane),
    },
  );
}
