// Ring buffer logów diagnostycznych + przechwytywanie konsoli procesu głównego.

const logBuffer: string[] = [];
const MAX_LOG_LINES = 20000;

let sink: ((entry: string) => void) | null = null;

export function setLogSink(cb: (entry: string) => void): void {
  sink = cb;
}

// ... w index.ts sink sprawdza widoczność okna — logi lecą przez IPC
// tylko gdy okno logów faktycznie widać.

export function appendLog(category: string, message: string): void {
  const ts = new Date().toLocaleTimeString('pl-PL', { hour12: false });
  const entry = `[${ts}] [${category}] ${message}`;
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.shift();
  }
  if (sink) sink(entry);
}

export function interceptConsole(): void {
  const origConsoleLog = console.log.bind(console);
  const origConsoleWarn = console.warn.bind(console);
  const origConsoleError = console.error.bind(console);

  const fmt = (args: unknown[]): string =>
    args
      .map((a) => {
        if (a instanceof Error) {
          return a.stack || a.message;
        }
        if (typeof a === 'object' && a !== null) {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(' ');

  console.log = (...args: unknown[]): void => {
    origConsoleLog(...args);
    appendLog('APP', fmt(args));
  };
  console.warn = (...args: unknown[]): void => {
    origConsoleWarn(...args);
    appendLog('WARN', fmt(args));
  };
  console.error = (...args: unknown[]): void => {
    origConsoleError(...args);
    appendLog('ERROR', fmt(args));
  };
}

export function getLogs(): string[] {
  return [...logBuffer];
}

export function clearLogs(): void {
  logBuffer.length = 0;
}
