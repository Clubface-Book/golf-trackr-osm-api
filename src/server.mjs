import "dotenv/config";
import express from "express";
import { getAiCaddyGeometry } from "./osmGolf.mjs";

const app = express();
const port = Number(process.env.PORT || 3000);
const apiKey = process.env.GOLF_TRACKR_API_KEY || "";

app.use(express.json({ limit: "64kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-golf-trackr-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

app.use((req, res, next) => {
  if (!apiKey) {
    next();
    return;
  }

  const suppliedKey = req.header("x-golf-trackr-api-key");
  if (suppliedKey !== apiKey) {
    res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "Missing or invalid API key.",
    });
    return;
  }

  next();
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "golf-trackr-osm-geometry-api" });
});

app.post("/v1/geometry/ai-caddy", async (req, res) => {
  try {
    const input = validateRequest(req.body || {});
    const result = await getAiCaddyGeometry(input);
    res.json(result);
  } catch (error) {
    if (error.statusCode) {
      res.status(error.statusCode).json({
        ok: false,
        error: error.code || "bad_request",
        message: error.message,
      });
      return;
    }

    console.error(error);
    res.status(500).json({
      ok: false,
      error: "server_error",
      message: "The geometry API could not complete this request.",
    });
  }
});

app.listen(port, () => {
  console.log(`Golf Trackr OSM Geometry API listening on http://localhost:${port}`);
});

function validateRequest(body) {
  const courseName = stringValue(body.course_name || body.courseName);
  const courseOsmId = stringValue(body.course_osm_id || body.courseOsmId);
  const hole = Number(body.hole || body.current_hole || body.currentHole);
  const lat = Number(body.lat || body.latitude);
  const lng = Number(body.lng || body.lon || body.longitude);

  if (!courseName && !courseOsmId) {
    throw requestError("course_name is required unless course_osm_id is supplied.", "missing_course_name");
  }

  if (!Number.isInteger(hole) || hole < 1 || hole > 36) {
    throw requestError("hole must be a number from 1 to 36.", "invalid_hole");
  }

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw requestError("lat must be a valid latitude.", "invalid_lat");
  }

  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw requestError("lng must be a valid longitude.", "invalid_lng");
  }

  return {
    courseName,
    courseOsmId,
    hole,
    lat,
    lng,
    selectedTeeName: stringValue(body.selected_tee_name || body.selectedTeeName),
    currentYardage: nullableNumber(body.current_yardage || body.currentYardage),
  };
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requestError(message, code) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}
