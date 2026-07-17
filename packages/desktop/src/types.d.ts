declare module '@xterm/headless/lib-headless/xterm-headless.js';
declare module 'diff';

declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: {
    setup: (...args: unknown[]) => void;
  };
}

declare module 'cookie' {
  export type CookieParseOptions = {
    decode?: (value: string) => string;
  };

  export function parse(cookieHeader: string, options?: CookieParseOptions): Record<string, string>;
}
