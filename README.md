# Golf Trackr OSM Geometry API

Small V1 Node API for Golf Trackr AI Caddy.

It accepts the current course, hole, and GPS location from Bubble, looks up OpenStreetMap golf geometry, and returns Bubble-ready JSON:

- distance to centre green
- nearest bunkers
- nearest water hazards
- course mapping status
- OSM attribution

This first version uses an in-memory cache only. Restarting the server clears the cache.

## Requirements

- Node 18+
- npm

## Install

```bash
npm install
```

Optional:

```bash
cp .env.example .env
```

If `GOLF_TRACKR_API_KEY` is left blank, the API accepts requests without a key.

## Run Locally

```bash
npm start
```

The API starts at:

```text
http://localhost:3000
```

Health check:

```bash
curl http://localhost:3000/health
```

## API Endpoint

```http
POST /v1/geometry/ai-caddy
Content-Type: application/json
```

Optional header if `GOLF_TRACKR_API_KEY` is set:

```http
x-golf-trackr-api-key: your-secret-key
```

## Request Body

```json
{
  "course_name": "Mid Kent Golf Club",
  "hole": 6,
  "lat": 51.4220989,
  "lng": 0.3652536,
  "selected_tee_name": "White",
  "current_yardage": 421
}
```

You can also pass `course_osm_id` if you already know it:

```json
{
  "course_osm_id": "way/4974222",
  "course_name": "Mid Kent Golf Club",
  "hole": 6,
  "lat": 51.4220989,
  "lng": 0.3652536
}
```

## Example Mid Kent Curl

```bash
curl -X POST http://localhost:3000/v1/geometry/ai-caddy \
  -H "Content-Type: application/json" \
  -d "{\"course_name\":\"Mid Kent Golf Club\",\"hole\":6,\"lat\":51.4220989,\"lng\":0.3652536,\"selected_tee_name\":\"White\",\"current_yardage\":421}"
```

Expected behaviour:

- `mapping_status` should be `full`
- `geometry_available` should be `true`
- `green.distance_from_user_yards` should be returned
- nearby bunkers and water hazards should be returned where OSM has them

## Example Rochester & Cobham Curl

```bash
curl -X POST http://localhost:3000/v1/geometry/ai-caddy \
  -H "Content-Type: application/json" \
  -d "{\"course_name\":\"Rochester and Cobham Park Golf Club\",\"hole\":6,\"lat\":51.3947,\"lng\":0.4289,\"selected_tee_name\":\"White\",\"current_yardage\":410}"
```

Expected behaviour:

- `mapping_status` should be `missing`
- `geometry_available` should be `false`
- `fallback_mode` should be `yardage_only`
- green, bunkers, and water hazards should be empty/null

## Example Response Shape

```json
{
  "ok": true,
  "mapping_status": "full",
  "geometry_available": true,
  "fallback_mode": null,
  "course": {
    "name": "Mid Kent Golf Club",
    "osm_id": "way/4974222",
    "center": {
      "lat": 51.4215161,
      "lng": 0.3629809
    },
    "attribution": "© OpenStreetMap contributors, ODbL"
  },
  "hole": 6,
  "selected_tee_name": "White",
  "current_yardage": 421,
  "green": {
    "osm_id": "way/123",
    "center": {
      "lat": 51.4189508,
      "lng": 0.3654262
    },
    "distance_from_user_yards": 383,
    "match": {
      "method": "nearest_hole_line",
      "meters": 20
    }
  },
  "nearest_bunkers": [],
  "nearest_water_hazards": [],
  "route": {},
  "data_quality": {
    "confidence": "high",
    "boundary_available": true,
    "hole_route_found": true,
    "green_found": true,
    "hole_refs_found": [1, 2, 3, 4, 5, 6],
    "feature_counts_inside_course": {
      "hole": 23,
      "green": 19,
      "tee": 35,
      "bunker": 53
    },
    "cache": {
      "status": "miss",
      "key": "course:way/4974222"
    },
    "notes": ["Hole route and green were found."]
  },
  "attribution": "© OpenStreetMap contributors, ODbL"
}
```

The exact OSM IDs and distances can change as OpenStreetMap is updated.

## Mapping Status

`full`

The API found a course, the requested hole route, and a green for that hole. Bubble can inject the geometry into the AI prompt.

`partial`

The API found the course and some useful golf features, but the requested hole is incomplete. Bubble can mention that mapping confidence is limited.

`missing`

The API could not find useful hole-level geometry. Bubble should use yardage-only AI Caddy mode.

## Bubble API Connector Setup

Create a new API call in Bubble:

- Name: `Get AI Caddy Geometry`
- Use as: `Action`
- Method: `POST`
- URL while local testing: `http://localhost:3000/v1/geometry/ai-caddy`
- Body type: `JSON`
- Headers:
  - `Content-Type`: `application/json`
  - `x-golf-trackr-api-key`: only if you set `GOLF_TRACKR_API_KEY`

Body:

```json
{
  "course_name": "<course name>",
  "hole": <current_hole>,
  "lat": <mobile latitude>,
  "lng": <mobile longitude>,
  "selected_tee_name": "<selected tee name>",
  "current_yardage": <current_yardage>
}
```

In the AI Caddy prompt, inject:

```text
Course mapping status: [mapping_status]
Distance to centre green: [green.distance_from_user_yards]
Nearest bunkers: [nearest_bunkers]
Nearest water hazards: [nearest_water_hazards]
OSM attribution: [attribution]
```

If `mapping_status` is `missing`, use:

```text
No reliable course geometry is available. Use only the player-provided yardage, par, stroke index, tee, handicap, and general golf strategy. Do not invent bunkers, water hazards, or green geometry.
```

## Notes

- The service uses OpenStreetMap data via Overpass.
- Always display or preserve attribution: `© OpenStreetMap contributors, ODbL`.
- In-memory cache is enough for local V1 testing, but it is not persistent.
- Mid Kent Golf Club is included as a known proof case: `way/4974222`.
- Rochester and Cobham Park Golf Club is included as a known missing-geometry case: `way/23725066`.
