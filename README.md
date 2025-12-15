## Google Maps Lead Gen (Next.js / Vercel)

Single unauthenticated API endpoint that:

- Geocodes `location` via Nominatim (`https://nominatim.openstreetmap.org/search`)
- Queries Google Maps via SerpApi Google Maps engine (`engine=google_maps`) and paginates using `start`
- Uses a query string of the form: `"<business_type> in <location>"`
- Returns **at most** `batch_size` businesses, deduplicated against your `existing_businesses` by `place_id`

Docs: `https://serpapi.com/google-maps-api`

### Local development

```bash
npm install
npm run dev
```

### Endpoint

`POST /api/leads?api_key=SERPAPI_KEY`

#### Request body

```json
{
  "location": "Ponsonby, Auckland",
  "business_type": "Property Managers",
  "batch_size": 25,
  "batch_start_index": 40,
  "existing_businesses": [
    {
      "Google Place ID": "ChIJZ7ChLrBHDW0RxXLjtbXfiyo",
      "Business Name": "Paxton Property Services Ltd"
    }
  ]
}
```

Notes:
- `existing_businesses` is deduped using the key `"Google Place ID"` (your example format).

#### Response

```json
{
  "location": "Ponsonby, Auckland",
  "business_type": "Property Managers",
  "ll": "@-36.8509,174.7645,14z",
  "batch_size": 25,
  "batch_start_index": 40,
  "new_batch_index": 65,
  "has_next": true,
  "results": [
    {
      "place_id": "....",
      "title": "...."
    }
  ],
  "meta": {
    "pages_scanned": 3,
    "deduped_against_existing_count": 1,
    "has_next_checked_pages": 2
  }
}
```

### How batching works (SerpApi limit = 20 per request)

SerpApi Google Maps returns up to 20 results per call. This API:

- Computes `firstPageStart = floor(batch_start_index / 20) * 20`
- Fetches that page, skips the first `(batch_start_index - firstPageStart)` items
- Continues fetching pages (`start += 20`) until it collects `batch_size` **deduplicated** businesses or runs out


