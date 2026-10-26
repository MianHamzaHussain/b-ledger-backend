/**
 * Stop cleanly when the process is asked to (systemd sends SIGTERM on every restart and deploy).
 *
 * Registering ANY listener for SIGTERM switches off Node's own "exit on SIGTERM", so a listener that only
 * cleared a timer left the server running until systemd gave up after 90 seconds and killed it — every
 * restart was a minute and a half of downtime. This is the one listener: it runs each step in order
 * (stop the timers, stop taking connections, close the database), then EXITS — and exits anyway after
 * `timeoutMs` if a step hangs, so a stuck connection can never hold the restart again.
 *
 * @param {object}   options
 * @param {Array<() => unknown>} options.steps   run in order; each may return a promise
 * @param {{ info: Function, error: Function }} options.log
 * @param {(code: number) => void} [options.exit]
 * @param {number}   [options.timeoutMs]
 * @returns {(signal: string) => Promise<void>} safe to call twice — the second call does nothing
 */
export const createShutdown = ({ steps, log, exit = process.exit, timeoutMs = 10_000 }) => {
  let started = false;

  return async signal => {
    if (started) return;
    started = true;
    log.info({ signal }, 'shutting down');

    const giveUp = setTimeout(() => {
      log.error({ timeoutMs }, 'shutdown took too long — exiting anyway');
      exit(1);
    }, timeoutMs);
    giveUp.unref();

    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        // One step failing must not stop the rest (the database still has to be closed).
        log.error({ err }, 'shutdown step failed');
      }
    }

    clearTimeout(giveUp);
    exit(0);
  };
};
