import http, { type IncomingMessage, type ServerResponse } from 'http';

export type R8LoopbackFixture = {
  baseUrl: string;
  close: () => Promise<void>;
};

export async function startR8LoopbackFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<R8LoopbackFixture> {
  const server = http.createServer((request, response) => {
    request.resume();
    handler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('R8 fixture did not expose a loopback port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function expectR8Signal(signal: Promise<void>, label: string, timeoutMs = 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} was not observed`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
