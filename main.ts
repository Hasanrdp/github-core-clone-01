// Lifecycle: bind an ephemeral port, register it with the trial harness,
// wait until the harness says it is done, then shut down cleanly.

import { createForgeServer } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }

  const server = createForgeServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('could not determine the listening port');
    process.exit(1);
  }
  const port = address.port;

  let registerResponse: Response;
  try {
    registerResponse = await fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
  } catch (err) {
    console.error('register failed', err);
    server.close();
    process.exit(1);
  }
  if (registerResponse.status === 409) {
    // Another entry won the registration; stand down quietly.
    server.close();
    process.exit(0);
  }
  if (!registerResponse.ok) {
    console.error(`register returned ${registerResponse.status}`);
    server.close();
    process.exit(1);
  }

  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) break;
      }
    } catch {
      // The harness may not be reachable yet; keep polling.
    }
    await sleep(250);
  }

  server.close();
  process.exit(0);
}

void main();
