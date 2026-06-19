import "dotenv/config";
import express from "express";
import { buildCourseGeometryForBubble, getAiCaddyGeometry } from "./osmGolf.mjs";

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

app.post("/v1/courses/geometry/build", async (req, res) => {
  try {
    const input = validateBuildRequest(req.body || {});
    console.log("[geometry-build] incoming", {
      course_name: input.courseName,
      course_key: input.courseKey,
      course_id: input.courseId || null,
      osm_id: input.courseOsmId || null,
    });

    const result = await buildCourseGeometryForBubble(input);

    console.log("[geometry-build] completed", {
      course_name: input.courseName,
      course_key: input.courseKey,
      build_status: result.build_status,
      mapping_status: result.mapping_status,
      geometry_available: result.geometry_available,
      holes: result.course_hole_geometries?.length || 0,
    });

    res.status(200).json(result);
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
      message: "The geometry build API could not complete this request.",
    });
  }
});

app.post("/v1/geometry/ai-caddy", async (req, res) => {
  try {
    const input = validateRequest(req.body || {});
    console.log("[ai-caddy] incoming", {
      course_name: input.courseName,
      hole: input.hole,
      stored_hole_geometry: Boolean(input.storedHoleGeometry),
    });

    const result = await getAiCaddyGeometry(input);
    const log = result._log || {};
    delete result._log;

    console.log("[ai-caddy] completed", {
      course_name: input.courseName,
      hole: input.hole,
      geometry_source: log.geometry_source || "unknown",
      fallback_reason: log.fallback_reason || null,
      mapping_status: result.mapping_status,
      fallback_mode: result.fallback_mode || null,
    });

    res.status(200).json(result);
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
  const courseOsmId = stringValue(body.osm_id || body.course_osm_id || body.courseOsmId);
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
    storedHoleGeometry: body.stored_hole_geometry || body.storedHoleGeometry || body.course_hole_geometry || null,
  };
}

function validateBuildRequest(body) {
  const courseName = stringValue(body.course_name || body.courseName);
  const courseId = stringValue(body.course_id || body.courseId);
  const courseKey = stringValue(body.course_key || body.courseKey || courseId) || fallbackCourseKey(courseName);
  const courseOsmId = stringValue(body.osm_id || body.course_osm_id || body.courseOsmId);
  const lat = nullableNumber(body.lat || body.latitude);
  const lng = nullableNumber(body.lng || body.lon || body.longitude);

  if (!courseName && !courseOsmId) {
    throw requestError("course_name is required unless osm_id is supplied.", "missing_course_name");
  }

  if (!courseKey) {
    throw requestError("course_key or course_id is required unless course_name can be used as a fallback.", "missing_course_key");
  }

  if (!courseOsmId && (!Number.isFinite(lat) || !Number.isFinite(lng))) {
    throw requestError("lat and lng are required when osm_id is not supplied.", "missing_search_location");
  }

  return {
    courseName,
    courseKey,
    courseId,
    courseOsmId,
    lat,
    lng,
  };
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function fallbackCourseKey(courseName) {
  return String(courseName || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function requestError(message, code) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}
