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
  api_key: string;
  location: string;
  business_type: string;
  batch_size: number;
  batch_start_index: number;
  existing_businesses: unknown; // array of objects (your Airtable-like rows)
};

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

function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}) ${url} ${text ? `- ${text}` : ""}`.trim());
  }
  return await res.json();
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

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Partial<RequestBody>;

    if (!isNonEmptyString(body.api_key)) {
      return NextResponse.json({ error: "Missing api_key (SerpApi key) in request body." }, { status: 400 });
    }
    if (!isNonEmptyString(body.location)) {
      return NextResponse.json({ error: "Missing location in request body." }, { status: 400 });
    }
    if (!isNonEmptyString(body.business_type)) {
      return NextResponse.json({ error: "Missing business_type in request body." }, { status: 400 });
    }
    if (!isFiniteInt(body.batch_size) || body.batch_size <= 0) {
      return NextResponse.json({ error: "batch_size must be a positive integer." }, { status: 400 });
    }
    if (!isFiniteInt(body.batch_start_index) || body.batch_start_index < 0) {
      return NextResponse.json({ error: "batch_start_index must be an integer >= 0." }, { status: 400 });
    }

    const batchSize = body.batch_size;
    const batchStartIndex = body.batch_start_index;
    const existingPlaceIds = normalizeExistingPlaceIds(body.existing_businesses);

    const { lat, lon } = await geocodeLocation(body.location);
    const ll = `@${lat},${lon},14z`;

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

    while (collected.length < batchSize && pages < maxPages) {
      pages++;
      const { local_results, nextStart } = await serpMapsSearch({
        apiKey: body.api_key,
        q: body.business_type,
        ll,
        start
      });

      if (!Array.isArray(local_results) || local_results.length === 0) break;

      const slice = isFirstPage ? local_results.slice(offsetWithinPage) : local_results;
      isFirstPage = false;

      for (const item of slice) {
        const pid = typeof item?.place_id === "string" ? item.place_id : "";
        if (!pid) continue;
        if (existingPlaceIds.has(pid)) continue;
        if (seenInThisRun.has(pid)) continue;
        seenInThisRun.add(pid);
        collected.push(item);
        if (collected.length >= batchSize) break;
      }

      if (nextStart === null) break;
      start = nextStart;
    }

    return NextResponse.json(
      {
        location: body.location,
        business_type: body.business_type,
        ll,
        batch_size: batchSize,
        batch_start_index: batchStartIndex,
        new_batch_index: batchStartIndex + batchSize,
        results: collected,
        meta: {
          pages_scanned: pages,
          deduped_against_existing_count: existingPlaceIds.size
        }
      },
      { status: 200 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}


