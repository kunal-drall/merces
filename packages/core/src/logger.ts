import pino, { type Logger as PinoLogger } from 'pino';

/**
 * Privacy-safe logger. Keys that could carry raw income, documents or hardship reasons are redacted at the
 * logger level so no code path can log them by accident (ground rule: no raw income at rest).
 * In tests, every emitted line is also captured in memory so the canary test (H3) can scan it.
 */
export const REDACTED_KEYS = [
  'income', 'incomeYtd', 'incomeYtdNow', 'incomeYtdPrev', 'figure', 'grossIncome', 'amountAttested', 'reason', 'hardshipReason', 'document', 'documents',
  'extractedParameters', 'extractedParameterValues', 'balance_transactions', 'payouts', 'threshold', 'salt', 'privateKey', 'secret', 'token', 'authorization', 'apiKey',
];

const captured: string[] = [];
export const logCapture = {
  enabled: false,
  /** suppress stdout (tests) */
  silent: false,
  lines: captured,
  reset(): void {
    captured.length = 0;
  },
};

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const k of REDACTED_KEYS) {
    paths.push(k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`);
  }
  return paths;
}

export type Logger = PinoLogger;

export function createLogger(name: string, level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  // The capture sees the serialised line AFTER redaction, exactly what would reach stdout.
  const destination = {
    write(chunk: string): void {
      if (logCapture.enabled) captured.push(chunk);
      if (!logCapture.silent) process.stdout.write(chunk);
    },
  };
  return pino({ name, level, redact: { paths: redactPaths(), censor: '[redacted]' } }, destination);
}
