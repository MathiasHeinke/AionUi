import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from '@playwright/test';

import { test } from '../fixtures';
import { invokeBridge } from '../helpers';

type ActiveSeatResponse =
  | { success?: boolean; data?: { ok?: boolean; seat_id?: string } }
  | { ok?: boolean; seat_id?: string };

type ReportExportResponse =
  | { success?: boolean; data?: { ok?: boolean; reason_code?: string; output_path?: string } }
  | { ok?: boolean; reason_code?: string; output_path?: string };

type PdfPrepareResponse =
  | {
      success?: boolean;
      data?: {
        ok?: boolean;
        reason_code?: string;
        message?: string;
        documents?: Array<{ sidecar_path?: string; extraction_mode?: string; page_count?: number }>;
      };
    }
  | {
      ok?: boolean;
      reason_code?: string;
      message?: string;
      documents?: Array<{ sidecar_path?: string; extraction_mode?: string; page_count?: number }>;
    };

function responseData<T>(response: T | { data?: T }): T {
  if (response && typeof response === 'object' && 'data' in response && response.data) return response.data;
  return response as T;
}

test.describe('Command EVE real PDF export', () => {
  test('writes a readable PDF through Electron printToPDF', async ({ page }) => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-pdf-export-e2e-'));
    const outputPath = path.join(outputDir, 'quarterly-report.pdf');

    try {
      const activeSeat = responseData(
        await invokeBridge<ActiveSeatResponse>(page, 'command-eve.active-seat', undefined, 15_000)
      );
      const seatId = activeSeat.seat_id || 'seat-1';

      const result = responseData(
        await invokeBridge<ReportExportResponse>(
          page,
          'command-eve.report-export',
          {
            format: 'pdf',
            markdown:
              '# Quarterly Report\n\nVerified PDF export from Command EVE 1.814. ' +
              'Revenue increased by twenty percent and the board approved the next operating plan.',
            seatId,
            outputPath,
            title: 'Quarterly Report',
            brand: { displayName: 'E2E Operator' },
          },
          30_000
        )
      );

      expect(result.ok, result.reason_code).toBe(true);
      expect(result.output_path).toBe(outputPath);

      const bytes = fs.readFileSync(outputPath);
      expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(bytes.byteLength).toBeGreaterThan(1_000);

      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const document = await getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false }).promise;
      const firstPage = await document.getPage(1);
      const text = await firstPage.getTextContent();
      const renderedText = text.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ');

      expect(renderedText).toContain('Quarterly Report');
      expect(renderedText).toContain('PDF export from Command EVE 1.814.');

      const prepared = responseData(
        await invokeBridge<PdfPrepareResponse>(
          page,
          'command-eve.pdf-prepare',
          { filePaths: [outputPath], allowCloudOcr: false, privacyLane: 'local_only' },
          30_000
        )
      );
      expect(prepared.ok, `${prepared.reason_code}: ${prepared.message ?? 'no detail'}`).toBe(true);
      expect(prepared.documents).toHaveLength(1);
      expect(prepared.documents?.[0]).toMatchObject({ extraction_mode: 'local_text', page_count: 1 });

      const sidecarPath = prepared.documents?.[0]?.sidecar_path;
      expect(sidecarPath).toBeTruthy();
      const sidecar = fs.readFileSync(sidecarPath as string, 'utf8');
      expect(sidecar).toContain('## PDF p. 1');
      expect(sidecar).toContain('Citation rule: cite claims from this document as `[PDF p. N]`');
      expect(sidecar).toContain('Revenue increased by twenty percent');
      expect(fs.statSync(sidecarPath as string).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
