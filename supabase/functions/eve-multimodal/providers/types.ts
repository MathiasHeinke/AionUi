export type FetchLike = typeof fetch;

export type PdfOcrUsageReservation =
  | {
      ok: true;
      allowed: boolean;
      reason: string;
      tenantUnits: number;
      tenantCap: number;
      globalUnits: number;
      globalCap: number;
      replayed: boolean;
    }
  | { ok: false; reason: string };

export type ReservePdfOcrUsage = (input: {
  tenantId: string;
  pages: number;
  tenantCap: number;
  globalCap: number;
  requestFingerprint: string;
}) => Promise<PdfOcrUsageReservation>;
