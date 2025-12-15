import { NextResponse } from "next/server";

type NominatimResult = {
  class?: string;
  type?: string;
  importance?: number | string;
  place_rank?: number | string;
  lat?: string | number;
  lon?: string | number;
  name?: string;
};

function getLatLon(results: unknown): { lat: number; lon: number; name?: string; type?: string } | null {
  if (!Array.isArray(results)) return null;
  const allowedTypes = new Set(["city", "town", "village", "suburb", "hamlet", "neighbourhood"]);
  const candidates = (results as NominatimResult[]).filter(
    (r) =>
      r &&
      r.class === "place" &&
      typeof r.type === "string" &&
      allowedTypes.has(r.type.toLowerCase())
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const impA = Number(a.importance ?? 0);
    const impB = Number(b.importance ?? 0);
    if (impA !== impB) return impB - impA;
    const prA = Number(a.place_rank ?? Infinity);
    const prB = Number(b.place_rank ?? Infinity);
    return prA - prB;
  });
  const best = candidates[0];
  const lat = Number(best.lat);
  const lon = Number(best.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { lat, lon, name: best.name, type: best.type };
  }
  return null;
}

type SerpMapsPlace = {
  place_id?: string;
  data_id?: string;
  data_cid?: string | number;
  title?: string;
  address?: string;
  phone?: string;
  website?: string;
  rating?: number;
  reviews?: number;
  type?: string;
  types?: string[];
  gps_coordinates?: { latitude?: number; longitude?: number };
  // passthrough any other fields SerpApi returns
  [k: string]: unknown;
};

type RequestBody = {
  location: string;
  business_type: string;
  batch_size: number;
  batch_start_index: number;
  existing_businesses: unknown; // array of objects (your Airtable-like rows)
};

function getRequestId() {
  // crypto.randomUUID is available in the Node.js runtime used by Vercel.
  // Fallback is extremely unlikely, but keeps local/polyfills happy.
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function redactBodyForLogs(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  if (Array.isArray(body)) return `[array length=${body.length}]`;
  const obj = body as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "existing_businesses" && Array.isArray(v)) {
      copy[k] = `[array length=${v.length}]`;
      continue;
    }
    copy[k] = v;
  }
  return copy;
}

function redactUrlForLogs(urlString: string): string {
  try {
    const url = new URL(urlString);
    if (url.searchParams.has("api_key")) url.searchParams.set("api_key", "[REDACTED]");
    return url.toString();
  } catch {
    return urlString;
  }
}

function getBodyKeysForDebug(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>);
}

function normalizeExistingPlaceIds(existing: unknown): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(existing)) return set;
  for (const item of existing) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    // Your existing businesses format uses "Google Place ID" for the place id value.
    // We intentionally ONLY use that field for dedupe against your existing list.
    const pid = obj["Google Place ID"] ?? obj["Google Place Id"];
    if (typeof pid === "string" && pid.trim()) set.add(pid.trim());
  }
  return set;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseIntFromUnknown(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && Number.isInteger(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    // allow "10" / "0010" / "-1" style strings; reject floats like "10.5"
    if (!/^-?\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) && Number.isInteger(n) ? n : null;
  }
  return null;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}) ${url} ${text ? `- ${text}` : ""}`.trim());
  }
  return await res.json();
}

async function readJsonBody(req: Request): Promise<{ body: unknown; rawText: string | null }> {
  // Read as text first so we can log/diagnose malformed JSON / wrong content-type.
  const rawText = await req.text();
  if (!rawText) return { body: null, rawText: "" };
  try {
    return { body: JSON.parse(rawText), rawText };
  } catch {
    return { body: null, rawText };
  }
}

async function geocodeLocation(location: string): Promise<{ lat: number; lon: number; name?: string; type?: string }> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", location);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("limit", "10");

  const json = await fetchJson(url.toString(), {
    headers: {
      // Nominatim usage policy expects a valid identifying UA.
      "User-Agent": "google-maps-lead-gen/1.0 (Vercel; contact: none)"
    }
  });

  const latLon = getLatLon(json);
  if (!latLon) throw new Error("Unable to resolve a city/town/village/suburb etc. for the given location.");
  return latLon;
}

async function serpMapsSearch(params: {
  apiKey: string;
  q: string;
  ll: string; // "@lat,lon,14z"
  start: number;
}): Promise<{ local_results: SerpMapsPlace[]; nextStart: number | null }> {
  // Per docs, Google Maps engine returns up to 20 results; pagination is via start.
  // Docs: https://serpapi.com/google-maps-api
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("api_key", params.apiKey);
  url.searchParams.set("q", params.q);
  url.searchParams.set("ll", params.ll);
  url.searchParams.set("type", "search");
  url.searchParams.set("start", String(params.start));

  const json = (await fetchJson(url.toString())) as any;
  const localResults: SerpMapsPlace[] = Array.isArray(json?.local_results) ? json.local_results : [];

  // Some responses include serpapi_pagination.next with start param; else infer +20 if any results.
  let nextStart: number | null = null;
  const nextUrl: string | undefined = json?.serpapi_pagination?.next;
  if (typeof nextUrl === "string") {
    try {
      const u = new URL(nextUrl);
      const s = Number(u.searchParams.get("start"));
      if (Number.isFinite(s)) nextStart = s;
    } catch {
      // ignore
    }
  }
  if (nextStart === null) {
    nextStart = localResults.length > 0 ? params.start + 20 : null;
  }

  return { local_results: localResults, nextStart };
}

async function computeHasNext(params: {
  apiKey: string;
  q: string;
  ll: string;
  fromIndex: number; // raw serp index to start checking from
  dedupePlaceIds: Set<string>; // existing + already returned in this response
  maxLookaheadPages?: number;
}): Promise<{ hasNext: boolean; pagesChecked: number }> {
  const maxLookaheadPages = params.maxLookaheadPages ?? 3;
  const firstPageStart = Math.floor(params.fromIndex / 20) * 20;
  const offsetWithinPage = params.fromIndex - firstPageStart;

  let start = firstPageStart;
  let pages = 0;
  let isFirstPage = true;

  while (pages < maxLookaheadPages) {
    pages++;
    const { local_results, nextStart } = await serpMapsSearch({
      apiKey: params.apiKey,
      q: params.q,
      ll: params.ll,
      start
    });

    if (!Array.isArray(local_results) || local_results.length === 0) {
      return { hasNext: false, pagesChecked: pages };
    }

    const slice = isFirstPage ? local_results.slice(offsetWithinPage) : local_results;
    isFirstPage = false;

    for (const item of slice) {
      const pid = typeof item?.place_id === "string" ? item.place_id : "";
      if (!pid) continue;
      if (params.dedupePlaceIds.has(pid)) continue;
      return { hasNext: true, pagesChecked: pages };
    }

    if (nextStart === null) {
      return { hasNext: false, pagesChecked: pages };
    }
    start = nextStart;
  }

  // Conservative: if we didn't find a new item within lookahead but pagination continues,
  // assume there may be more further out.
  return { hasNext: true, pagesChecked: pages };
}

export async function POST(req: Request): Promise<Response> {
  const requestId = getRequestId();
  const startedAt = Date.now();
  const vercelId = req.headers.get("x-vercel-id");
  const contentType = req.headers.get("content-type");
  const requestUrl = req.url;

  const log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => {
    const payload = {
      request_id: requestId,
      vercel_id: vercelId ?? undefined,
      at_ms: Date.now(),
      msg,
      ...extra
    };
    if (level === "error") console.error("[/api/leads]", payload);
    else if (level === "warn") console.warn("[/api/leads]", payload);
    else console.log("[/api/leads]", payload);
  };

  try {
    const url = new URL(requestUrl);
    const apiKey = url.searchParams.get("api_key") ?? "";

    log("info", "request_received", {
      method: req.method,
      content_type: contentType ?? undefined,
      url: redactUrlForLogs(requestUrl)
    });

    const { body: rawBody, rawText } = await readJsonBody(req);
    const body = (rawBody ?? {}) as Partial<RequestBody>;

    log("info", "request_body_parsed", {
      body_keys: getBodyKeysForDebug(body),
      body_redacted: redactBodyForLogs(body),
      // Don't dump the whole raw body (could be huge). Keep a small preview for debugging.
      raw_text_preview: rawText && rawText.length > 0 ? rawText.slice(0, 500) : rawText
    });

    if (!isNonEmptyString(apiKey)) {
      log("warn", "validation_failed_missing_api_key_query_param");
      return NextResponse.json(
        { error: "Missing api_key (SerpApi key) in query string (?api_key=...)", request_id: requestId, received_body_keys: getBodyKeysForDebug(body) },
        { status: 400 }
      );
    }
    if (!isNonEmptyString(body.location)) {
      log("warn", "validation_failed_missing_location", { received_body_keys: getBodyKeysForDebug(body) });
      return NextResponse.json(
        { error: "Missing location in request body.", request_id: requestId, received_body_keys: getBodyKeysForDebug(body) },
        { status: 400 }
      );
    }
    if (!isNonEmptyString(body.business_type)) {
      log("warn", "validation_failed_missing_business_type", { received_body_keys: getBodyKeysForDebug(body) });
      return NextResponse.json(
        { error: "Missing business_type in request body.", request_id: requestId, received_body_keys: getBodyKeysForDebug(body) },
        { status: 400 }
      );
    }
    const parsedBatchSize = parseIntFromUnknown(body.batch_size);
    if (parsedBatchSize === null || parsedBatchSize <= 0) {
      log("warn", "validation_failed_invalid_batch_size", { batch_size_raw: body.batch_size, batch_size_parsed: parsedBatchSize });
      return NextResponse.json(
        { error: "batch_size must be a positive integer.", request_id: requestId, received_body_keys: getBodyKeysForDebug(body) },
        { status: 400 }
      );
    }
    const parsedBatchStartIndex = parseIntFromUnknown(body.batch_start_index);
    if (parsedBatchStartIndex === null || parsedBatchStartIndex < 0) {
      log("warn", "validation_failed_invalid_batch_start_index", {
        batch_start_index_raw: body.batch_start_index,
        batch_start_index_parsed: parsedBatchStartIndex
      });
      return NextResponse.json(
        { error: "batch_start_index must be an integer >= 0.", request_id: requestId, received_body_keys: getBodyKeysForDebug(body) },
        { status: 400 }
      );
    }

    const batchSize = parsedBatchSize;
    const batchStartIndex = parsedBatchStartIndex;
    const existingPlaceIds = normalizeExistingPlaceIds(body.existing_businesses);

    log("info", "validated_request", {
      location: body.location,
      business_type: body.business_type,
      batch_size: batchSize,
      batch_start_index: batchStartIndex,
      batch_size_raw: body.batch_size,
      batch_start_index_raw: body.batch_start_index,
      existing_businesses_dedupe_set_size: existingPlaceIds.size
    });

    const { lat, lon } = await geocodeLocation(body.location);
    const ll = `@${lat},${lon},14z`;

    log("info", "geocode_success", { ll });

    // We need "results starting from batchStartIndex" even though SerpApi returns fixed 20/page.
    // Strategy:
    // - Start fetching at floor(batchStartIndex/20)*20
    // - Skip offsetWithinPage items
    // - Keep collecting unique (deduped) results until we have batchSize, paging start+=20
    const firstPageStart = Math.floor(batchStartIndex / 20) * 20;
    const offsetWithinPage = batchStartIndex - firstPageStart;

    const collected: SerpMapsPlace[] = [];
    const seenInThisRun = new Set<string>(); // prevent duplicates across pages even if SerpApi repeats

    let start = firstPageStart;
    let isFirstPage = true;

    // hard cap to avoid runaway costs; adjust if you want
    const maxPages = 25; // up to 500 results scanned
    let pages = 0;

    const serpQuery = `${body.business_type} in ${body.location}`;
    log("info", "serpapi_paging_begin", {
      q: serpQuery,
      ll,
      first_page_start: firstPageStart,
      offset_within_page: offsetWithinPage,
      max_pages: maxPages
    });

    while (collected.length < batchSize && pages < maxPages) {
      pages++;
      const { local_results, nextStart } = await serpMapsSearch({
        apiKey,
        q: serpQuery,
        ll,
        start
      });

      if (!Array.isArray(local_results) || local_results.length === 0) break;

      const slice = isFirstPage ? local_results.slice(offsetWithinPage) : local_results;
      isFirstPage = false;

      const before = collected.length;
      for (const item of slice) {
        const pid = typeof item?.place_id === "string" ? item.place_id : "";
        if (!pid) continue;
        if (existingPlaceIds.has(pid)) continue;
        if (seenInThisRun.has(pid)) continue;
        seenInThisRun.add(pid);
        collected.push(item);
        if (collected.length >= batchSize) break;
      }
      const added = collected.length - before;

      log("info", "serpapi_page_scanned", {
        page: pages,
        start,
        returned_count: local_results.length,
        considered_count: slice.length,
        added_count: added,
        collected_total: collected.length,
        next_start: nextStart
      });

      if (nextStart === null) break;
      start = nextStart;
    }

    log("info", "request_success", {
      pages_scanned: pages,
      results_count: collected.length,
      duration_ms: Date.now() - startedAt
    });

    const newBatchIndex = batchStartIndex + batchSize;
    const dedupeForNext = new Set<string>(existingPlaceIds);
    for (const r of collected) {
      const pid = typeof r?.place_id === "string" ? r.place_id : "";
      if (pid) dedupeForNext.add(pid);
    }

    log("info", "has_next_check_begin", { from_index: newBatchIndex });
    const { hasNext, pagesChecked } = await computeHasNext({
      apiKey,
      q: serpQuery,
      ll,
      fromIndex: newBatchIndex,
      dedupePlaceIds: dedupeForNext,
      maxLookaheadPages: 3
    });
    log("info", "has_next_check_done", { has_next: hasNext, pages_checked: pagesChecked });

    return NextResponse.json(
      {
        location: body.location,
        business_type: body.business_type,
        ll,
        batch_size: batchSize,
        batch_start_index: batchStartIndex,
        new_batch_index: newBatchIndex,
        has_next: hasNext,
        results: collected,
        meta: {
          pages_scanned: pages,
          deduped_against_existing_count: existingPlaceIds.size,
          has_next_checked_pages: pagesChecked
        }
      },
      { status: 200 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[/api/leads]", {
      request_id: requestId,
      vercel_id: vercelId ?? undefined,
      msg: "request_failed",
      error: msg,
      stack
    });
    return NextResponse.json({ error: msg, request_id: requestId }, { status: 500 });
  }
}


