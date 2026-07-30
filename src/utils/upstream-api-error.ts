export type UpstreamApiErrorCode =
  | 'context_window_exceeded'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'authentication_failed'
  | 'provider_api_error';

export interface UpstreamApiError {
  code: UpstreamApiErrorCode;
  message: string;
  raw: string;
  httpStatus?: number;
  requestId?: string;
  retryable: boolean;
}

export interface ApiTaskLikeResult {
  success: boolean;
  responseText?: string;
  error?: string;
}

export type UpstreamAwareTaskResult<T extends ApiTaskLikeResult = ApiTaskLikeResult> = T & {
  errorCode?: UpstreamApiErrorCode;
  upstreamStatus?: number;
  upstreamRequestId?: string;
  retryable?: boolean;
};

const CONTEXT_WINDOW_RE =
  /context(?:[ ._-]+)window(?:[ ._-]+)exceeds(?:[ ._-]+)limit|context(?:[ ._-]+)length(?:[ ._-]+)exceeded|context(?:[ ._-]+)too(?:[ ._-]+)long|max(?:imum)?(?:[ ._-]+)context(?:[ ._-]+)length|token(?:[ ._-]+)limit(?:[ ._-]+)exceeded/i;
const QUOTA_RE = /quota|credits?.exhausted|insufficient.balance|usage.limit/i;
const AUTH_RE = /unauthori[sz]ed|forbidden|invalid.api.key|authentication.failed/i;
const RATE_LIMIT_RE = /rate.limit|too.many.requests/i;
const REQUEST_ID_RE = /\brequest\s*id\s*:\s*([A-Za-z0-9_-]+)/i;
const API_ERROR_LINE_RE = /^API Error:\s*(\d{3})\s+(.+)$/i;

const ALLOWED_PREAMBLE = [
  /^本次无数据可记[，,]?\s*跳过入库[。.]?$/,
  /^no data (?:to save|was recorded)[,;.]?\s*(?:skipping|skip persistence)?[。.]?$/i,
  /^error:?$/i,
];

function classify(message: string, httpStatus?: number): {
  code: UpstreamApiErrorCode;
  retryable: boolean;
} {
  if (CONTEXT_WINDOW_RE.test(message)) {
    return { code: 'context_window_exceeded', retryable: true };
  }
  if (httpStatus === 429 || RATE_LIMIT_RE.test(message)) {
    return { code: 'rate_limited', retryable: true };
  }
  if (QUOTA_RE.test(message)) {
    return { code: 'quota_exhausted', retryable: false };
  }
  if (httpStatus === 401 || httpStatus === 403 || AUTH_RE.test(message)) {
    return { code: 'authentication_failed', retryable: false };
  }
  return {
    code: 'provider_api_error',
    retryable: httpStatus !== undefined && httpStatus >= 500,
  };
}

/**
 * Detect provider/engine errors that were emitted as ordinary assistant text.
 *
 * Some engines prepend a persistence notice before the real API error:
 *
 *   本次无数据可记，跳过入库。
 *
 *   API Error: 400 context window exceeds limit Request id: ...
 *
 * We accept only a tiny allow-list of boilerplate before an `API Error:` line
 * so normal prose that happens to quote an API error is not misclassified.
 * `allowBare` is reserved for trusted error fields, where no `API Error:`
 * wrapper may be present.
 */
export function detectUpstreamApiError(
  text?: string,
  options: { allowBare?: boolean } = {},
): UpstreamApiError | undefined {
  const raw = text?.trim();
  if (!raw) return undefined;

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const apiLineIndex = lines.findIndex((line) => API_ERROR_LINE_RE.test(line));

  let httpStatus: number | undefined;
  let message: string;

  if (apiLineIndex >= 0) {
    const preamble = lines.slice(0, apiLineIndex);
    const trailing = lines.slice(apiLineIndex + 1);
    if (!preamble.every((line) => ALLOWED_PREAMBLE.some((pattern) => pattern.test(line)))) {
      return undefined;
    }
    if (!trailing.every((line) => REQUEST_ID_RE.test(line))) {
      return undefined;
    }

    const match = lines[apiLineIndex].match(API_ERROR_LINE_RE);
    if (!match) return undefined;
    httpStatus = Number(match[1]);
    message = match[2].trim();
    if (trailing.length > 0) message += ` ${trailing.join(' ')}`;
  } else {
    if (!options.allowBare || raw.length > 2000) return undefined;
    if (
      !CONTEXT_WINDOW_RE.test(raw)
      && !RATE_LIMIT_RE.test(raw)
      && !QUOTA_RE.test(raw)
      && !AUTH_RE.test(raw)
    ) {
      return undefined;
    }
    const statusMatch = raw.match(/\b([45]\d{2})\b/);
    httpStatus = statusMatch ? Number(statusMatch[1]) : undefined;
    message = raw;
  }

  const requestId = message.match(REQUEST_ID_RE)?.[1];
  const cleanMessage = message.replace(REQUEST_ID_RE, '').trim();
  const classification = classify(cleanMessage, httpStatus);
  return {
    ...classification,
    raw,
    message: cleanMessage,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export function formatUpstreamApiError(error: UpstreamApiError): string {
  const status = error.httpStatus ? ` ${error.httpStatus}` : '';
  const requestId = error.requestId ? ` (requestId: ${error.requestId})` : '';
  return `[${error.code}] Upstream API error${status}: ${error.message}${requestId}`;
}

/**
 * Fail closed when a bridge or peer accidentally reports an embedded provider
 * error as `success: true`. Direct error fields allow bare provider messages;
 * assistant response text requires the stricter `API Error:` wrapper.
 */
export function normalizeApiTaskResult<T extends ApiTaskLikeResult>(
  result: T,
): UpstreamAwareTaskResult<T> {
  const detected = detectUpstreamApiError(result.error, { allowBare: true })
    ?? detectUpstreamApiError(result.responseText);
  if (!detected) return result;

  return {
    ...result,
    success: false,
    error: formatUpstreamApiError(detected),
    errorCode: detected.code,
    upstreamStatus: detected.httpStatus,
    upstreamRequestId: detected.requestId,
    retryable: detected.retryable,
  };
}
