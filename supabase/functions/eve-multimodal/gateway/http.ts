const DEFAULT_ALLOWED_ORIGINS = Object.freeze(['app://command-eve', 'http://localhost:1420', 'http://localhost:5173']);

function allowedOrigins(): readonly string[] {
  const configured = Deno.env.get('EVE_MULTIMODAL_ALLOWED_ORIGINS');
  if (!configured) return DEFAULT_ALLOWED_ORIGINS;
  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  const allowOrigin = !origin ? '*' : allowedOrigins().includes(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(req) },
  });
}

export function blocked(
  req: Request,
  reason: string,
  message: string,
  status: number,
  now: string,
  provider: 'xai' | 'openrouter' = 'xai'
): Response {
  const body = {
    ok: false,
    gateway: 'eve-multimodal',
    provider,
    reason,
    message,
    checked_at: now,
  };
  return jsonResponse(req, body, status);
}
