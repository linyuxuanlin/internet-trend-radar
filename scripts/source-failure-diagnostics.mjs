const HTTP_RE = /(?:^|\b)HTTP\s+(\d{3})(?:\b|$)/i;

function normalizeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return code || null;
}

export function classifySourceFailure(input) {
  const rawMessage = input && typeof input === 'object'
    ? (input.message ?? input.last_error ?? '')
    : (input ?? '');
  const message = String(rawMessage).trim();
  const explicitCode = normalizeCode(input?.code ?? input?.cause?.code ?? input?.last_error_code);
  const explicitType = String(input?.last_error_type || '').trim().toLowerCase();
  if (!message && !explicitCode && !explicitType) return { type: null, code: null };

  if (explicitType) return { type: explicitType, code: explicitCode };

  const http = message.match(HTTP_RE);
  if (http) return { type: 'http', code: `HTTP_${http[1]}` };

  const code = explicitCode;
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(code)) return { type: 'dns', code };
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR'].includes(code)) {
    return { type: 'timeout', code };
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_ERROR'].includes(code)) {
    return { type: 'network', code };
  }

  if (/certificate|cert_|tls|ssl|unable to verify|self[- ]signed/i.test(message)) return { type: 'tls', code };
  if (/abort|timed?\s*out|timeout/i.test(message)) return { type: 'timeout', code };
  if (/empty data|no usable|contains no items|empty response|no items/i.test(message)) return { type: 'empty-data', code };
  if (/fetch failed|socket|connect|network/i.test(message)) return { type: 'network', code };

  return { type: 'unknown', code };
}
