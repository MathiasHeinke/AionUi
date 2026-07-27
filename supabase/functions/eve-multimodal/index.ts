// Command EVE — eve-multimodal Edge Function.
//
// AUTH MODEL: the Bearer credential is the raw CEVE license WIRE, not a
// Supabase JWT. Deploy with:
//   supabase functions deploy eve-multimodal --no-verify-jwt
//
// The bounded gateway modules preserve the existing authentication,
// entitlement, metering, privacy, provider-selection and response contracts.

import { handleEveMultimodal } from './gateway/handler.ts';

export { handleEveMultimodal };
export { resetEveMultimodalPublicKeyCacheForTests } from './gateway/license.ts';

if (typeof Deno !== 'undefined' && (import.meta as { main?: boolean }).main) {
  Deno.serve((req) => handleEveMultimodal(req));
}
