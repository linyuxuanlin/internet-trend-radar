import baseWorker from './index.js';
import { aiAvailabilityStatus } from './api.js';

export function mergeAIAvailabilityIntoDebug(debug, availability) {
  const payload = debug && typeof debug === 'object' ? debug : {};
  payload.ai = payload.ai && typeof payload.ai === 'object' ? payload.ai : {};

  if (!availability || availability.ok !== true) {
    payload.ai.effective_blocker = payload.ai.blocked_reason || availability?.effective_blocker || 'availability-probe-failed';
    payload.ai.availability_ok = false;
    return payload;
  }

  payload.ai.availability_ok = true;
  payload.ai.effective_blocker = availability.effective_blocker || null;
  payload.ai.provider_quota = availability.provider_quota;
  payload.ai.pacing = availability.pacing;
  payload.ai.available = Boolean(availability.available);

  if (availability.effective_blocker) {
    payload.ai.blocked_reason = availability.effective_blocker;
    payload.ai.ready_for_inference = false;
  }

  return payload;
}

export function isForbiddenPreviewPath(pathname) {
  return pathname.startsWith('/api/topic/preview-');
}

export function isPreviewPayload(payload) {
  return Boolean(payload && typeof payload === 'object' && payload.preview === true);
}

async function rejectPreviewResponse(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return response;

  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  if (!isPreviewPayload(payload)) return response;

  return Response.json({
    error: 'preview payloads are disabled in production',
    ready: false,
    preview: false,
    upstream_status: response.status
  }, { status: 503 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (isForbiddenPreviewPath(url.pathname)) {
      return Response.json({ error: 'preview topics are disabled in production', ready: false, preview: false }, { status: 404 });
    }
    if (url.pathname !== '/api/debug') {
      const response = await baseWorker.fetch(request, env, ctx);
      return url.pathname.startsWith('/api/') ? rejectPreviewResponse(response) : response;
    }

    const response = await baseWorker.fetch(request, env, ctx);
    let debug;
    try {
      debug = await response.clone().json();
    } catch {
      return response;
    }

    try {
      const availability = await aiAvailabilityStatus(env);
      return rejectPreviewResponse(Response.json(mergeAIAvailabilityIntoDebug(debug, availability), { status: response.status }));
    } catch (error) {
      debug.ai = debug.ai && typeof debug.ai === 'object' ? debug.ai : {};
      debug.ai.availability_ok = false;
      debug.ai.effective_blocker = debug.ai.blocked_reason || 'availability-probe-failed';
      debug.ai.availability_error = String(error?.message || error);
      return rejectPreviewResponse(Response.json(debug, { status: response.status }));
    }
  },

  async scheduled(controller, env, ctx) {
    return baseWorker.scheduled(controller, env, ctx);
  }
};
