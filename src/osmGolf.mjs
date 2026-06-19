const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const OVERPASS_TIMEOUT_MS = Number(process.env.OVERPASS_TIMEOUT_MS || 120000);
const YARDS_PER_METER = 1.0936132983377078;
const DEFAULT_CACHE_TTL_MS = Number(process.env.COURSE_CACHE_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const DEFAULT_SEARCH_RADIUS_METERS = Number(process.env.SEARCH_RADIUS_METERS || 5000);
const DEFAULT_FEATURE_RADIUS_METERS = Number(process.env.FEATURE_RADIUS_METERS || 1200);
const DEFAULT_HOLE_MATCH_METERS = Number(process.env.HOLE_MATCH_METERS || 100);
const DEFAULT_MAX_HAZARDS = Number(process.env.MAX_HAZARDS || 3);
const ATTRIBUTION = "© OpenStreetMap contributors, ODbL";

const courseCache = new Map();

const KNOWN_COURSES = [
  {
    match: ["mid kent golf club", "mid kent"],
    osmType: "way",
    osmId: 4974222,
    name: "Mid Kent Golf Club",
  },
  {
    match: [
      "rochester and cobham park golf club",
      "rochester & cobham park golf club",
      "rochester and cobham",
      "rochester & cobham",
    ],
    osmType: "way",
    osmId: 23725066,
    name: "Rochester and Cobham Park Golf Club",
  },
];

export async function getAiCaddyGeometry(input) {
  const options = {
    courseName: input.courseName,
    courseOsmId: input.courseOsmId,
    hole: input.hole,
    lat: input.lat,
    lng: input.lng,
    selectedTeeName: input.selectedTeeName,
    currentYardage: input.currentYardage,
    maxHazards: DEFAULT_MAX_HAZARDS,
    storedHoleGeometry: input.storedHoleGeometry,
  };

  const storedGeometry = parseStoredHoleGeometry(options.storedHoleGeometry);
  if (!storedGeometry) {
    return withLog(
      missingResponse({ input: options }),
      {
        geometry_source: "none",
        fallback_reason: "stored_hole_geometry_missing_or_invalid",
      },
    );
  }

  const response = buildStoredAiCaddyResponse(storedGeometry, options);
  return withLog(response, {
    geometry_source: response.fallback_mode ? "fallback" : "stored_hole_geometry",
    fallback_reason: response.fallback_mode ? "stored_hole_geometry_incomplete" : null,
  });
}

export async function buildCourseGeometryForBubble(input) {
  const attemptedAt = new Date().toISOString();
  const options = {
    courseName: input.courseName,
    courseKey: input.courseKey,
    courseId: input.courseId,
    courseOsmId: input.courseOsmId,
    lat: input.lat,
    lng: input.lng,
    searchRadiusMeters: DEFAULT_SEARCH_RADIUS_METERS,
    featureRadiusMeters: DEFAULT_FEATURE_RADIUS_METERS,
    holeMatchMeters: DEFAULT_HOLE_MATCH_METERS,
    maxHazards: DEFAULT_MAX_HAZARDS,
  };

  try {
    console.log("[geometry-build] stage:start", {
      course_name: options.courseName,
      course_key: options.courseKey,
      osm_id: options.courseOsmId || null,
    });

    const explicitOsmId = parseOsmId(options.courseOsmId);
    const course = explicitOsmId ? minimalCourseFromExplicitOsmId(explicitOsmId, options) : await resolveCourse(options);

    if (explicitOsmId) {
      console.log("[geometry-build] stage:skipFetchCourseByOsmId explicit_osm_id", {
        course_name: options.courseName,
        course_key: options.courseKey,
        osm_id: osmId(course),
        center: courseCenter(course),
      });
    }

    if (!course) {
      console.log("[geometry-build] stage:resolveCourse no_course_found", {
        course_name: options.courseName,
        course_key: options.courseKey,
      });
      return buildBubbleGeometryFallback({
        input: options,
        attemptedAt,
        buildError: "course_not_found",
      });
    }

    console.log("[geometry-build] stage:resolveCourse success", {
      course_name: options.courseName,
      course_key: options.courseKey,
      osm_id: osmId(course),
    });

    const geometry = await getCachedCourseGeometry(course, options);
    console.log("[geometry-build] stage:buildCourseGeometry success", {
      course_name: options.courseName,
      course_key: options.courseKey,
      osm_id: osmId(course),
      feature_counts: geometry.featureCounts,
      hole_refs_found: geometry.holeRefsFound,
      cache_status: geometry.cache?.status || null,
    });

    return buildBubbleGeometryResponse({
      input: options,
      geometry,
      attemptedAt,
    });
  } catch (error) {
    console.log("[geometry-build] stage:failed", {
      course_name: options.courseName,
      course_key: options.courseKey,
      failing_stage: error.stage || "unknown",
      error: readableError(error),
    });

    return buildBubbleGeometryFallback({
      input: options,
      attemptedAt,
      buildError: readableError(error),
    });
  }
}

async function resolveCourse(options) {
  const explicitOsmId = parseOsmId(options.courseOsmId);
  if (explicitOsmId) {
    console.log("[geometry-build] stage:resolveCourse explicit_osm_id", {
      osm_id: `${explicitOsmId.type}/${explicitOsmId.id}`,
    });
    return fetchCourseByOsmId(explicitOsmId);
  }

  const knownCourse = knownCourseForName(options.courseName);
  if (knownCourse) {
    console.log("[geometry-build] stage:resolveCourse known_course", {
      course_name: options.courseName,
      osm_id: `${knownCourse.osmType}/${knownCourse.osmId}`,
    });
    const course = await fetchCourseByOsmId({
      type: knownCourse.osmType,
      id: knownCourse.osmId,
    });

    if (course) return course;
  }

  console.log("[geometry-build] stage:resolveCourse name_search", {
    course_name: options.courseName,
    lat: options.lat,
    lng: options.lng,
    search_radius_meters: options.searchRadiusMeters,
  });
  return findCourseByName(options);
}

async function getCachedCourseGeometry(course, options) {
  const key = `course:${osmId(course)}`;
  const cached = courseCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.value,
      cache: {
        status: "hit",
        key,
        expires_at: new Date(cached.expiresAt).toISOString(),
      },
    };
  }

  const value = await buildCourseGeometry(course, options);
  const expiresAt = Date.now() + DEFAULT_CACHE_TTL_MS;

  courseCache.set(key, { value, expiresAt });

  return {
    ...value,
    cache: {
      status: "miss",
      key,
      expires_at: new Date(expiresAt).toISOString(),
    },
  };
}

async function buildCourseGeometry(course, options) {
  const rawElements = await fetchCourseFeatureElements(course, options);
  const courseBoundary = getGeometry(course);

  const candidates = rawElements
    .filter((element) => element.id !== course.id || element.type !== course.type)
    .filter((element) => isWantedFeature(element))
    .map((element) => ({
      element,
      kind: featureKind(element),
      center: centroid(element),
      geometry: getGeometry(element),
    }))
    .filter((feature) => feature.center);

  const featuresInsideCourse = isClosedRing(courseBoundary)
    ? candidates.filter((feature) => pointInRing(feature.center, courseBoundary))
    : candidates;

  const holes = featuresInsideCourse
    .filter((feature) => feature.kind === "hole")
    .map((feature) => ({
      ...feature,
      ref: numericRef(feature.element.tags?.ref),
      line: getGeometry(feature.element),
    }))
    .filter((hole) => Number.isFinite(hole.ref) && hole.line.length > 1);

  const holeMap = new Map();

  for (const hole of holes) {
    ensureHoleRecord(holeMap, hole.ref).holeRoutes.push(hole);
  }

  for (const feature of featuresInsideCourse) {
    if (feature.kind === "hole") continue;

    const directRef = numericRef(feature.element.tags?.ref);
    if (Number.isFinite(directRef)) {
      ensureHoleRecord(holeMap, directRef).features.push({
        ...feature,
        match: { method: "feature_ref", meters: 0 },
      });
      continue;
    }

    const nearest = nearestHole(feature.center, holes, options.holeMatchMeters);
    if (nearest) {
      ensureHoleRecord(holeMap, nearest.hole.ref).features.push({
        ...feature,
        match: { method: "nearest_hole_line", meters: nearest.meters },
      });
    }
  }

  return {
    course,
    courseBoundary,
    featuresInsideCourse,
    holeMap,
    holeRefsFound: [...holeMap.keys()].sort((a, b) => a - b),
    featureCounts: countBy(featuresInsideCourse, "kind"),
  };
}

function buildAiCaddyResponse(geometry, options) {
  const holeRecord = geometry.holeMap.get(options.hole) || null;
  const holeRoutes = holeRecord?.holeRoutes || [];
  const primaryRoute = holeRoutes[0] || null;
  const features = holeRecord?.features || [];
  const greens = features.filter((feature) => feature.kind === "green");
  const bunkers = features.filter((feature) => feature.kind === "bunker");
  const waterHazards = features.filter((feature) => isWaterKind(feature.kind));
  const primaryGreen = pickPrimaryGreen(greens, primaryRoute);
  const userPoint = [options.lng, options.lat];
  const mappingStatus = classifyMappingStatus({
    geometry,
    holeRecord,
    primaryRoute,
    primaryGreen,
  });

  if (mappingStatus === "missing") {
    return missingResponse({
      input: options,
      course: geometry.course,
      geometry,
      message: "Course found, but reliable hole-level mapping is not available.",
      reason: "hole_geometry_missing",
    });
  }

  return {
    ok: true,
    mapping_status: mappingStatus,
    geometry_available: Boolean(primaryGreen),
    fallback_mode: mappingStatus === "partial" ? "partial_geometry" : null,
    course: courseSummary(geometry.course),
    hole: options.hole,
    selected_tee_name: options.selectedTeeName || null,
    current_yardage: options.currentYardage,
    green: primaryGreen
      ? {
          osm_id: osmId(primaryGreen.element),
          center: latLng(primaryGreen.center),
          distance_from_user_yards: yardsBetween(userPoint, primaryGreen.center),
          match: primaryGreen.match || null,
        }
      : null,
    nearest_bunkers: nearestFeatures(bunkers, userPoint, options.maxHazards),
    nearest_water_hazards: nearestFeatures(waterHazards, userPoint, options.maxHazards),
    route: primaryRoute
      ? {
          osm_id: osmId(primaryRoute.element),
          ref: String(primaryRoute.ref),
          par: primaryRoute.element.tags?.par || null,
          coordinates: primaryRoute.line.map(([lng, lat]) => ({ lat: roundCoord(lat), lng: roundCoord(lng) })),
        }
      : null,
    data_quality: {
      confidence: mappingStatus === "full" ? "high" : "medium",
      boundary_available: isClosedRing(geometry.courseBoundary),
      hole_route_found: Boolean(primaryRoute),
      green_found: Boolean(primaryGreen),
      hole_refs_found: geometry.holeRefsFound,
      feature_counts_inside_course: geometry.featureCounts,
      cache: geometry.cache,
      notes: qualityNotes(geometry, options, primaryRoute, primaryGreen),
    },
    attribution: ATTRIBUTION,
  };
}

function classifyMappingStatus({ geometry, holeRecord, primaryRoute, primaryGreen }) {
  const usefulFeatureCount = Object.entries(geometry.featureCounts)
    .filter(([kind]) => kind !== "other")
    .reduce((total, [, count]) => total + count, 0);

  if (usefulFeatureCount === 0) return "missing";
  if (primaryRoute && primaryGreen) return "full";
  if (holeRecord || primaryGreen || usefulFeatureCount > 0) return "partial";
  return "missing";
}

function missingResponse({ input }) {
  return {
    ok: true,
    mapping_status: "missing",
    geometry_available: false,
    fallback_mode: "yardage_only",
    course: {
      name: input.courseName || null,
      osm_id: null,
      attribution: ATTRIBUTION,
    },
    hole: input.hole,
    selected_tee_name: input.selectedTeeName || null,
    current_yardage: input.currentYardage,
    green: null,
    nearest_bunkers: [],
    nearest_water_hazards: [],
    route: {},
    data_quality: {
      confidence: "none",
      boundary_available: false,
      hole_route_found: false,
      green_found: false,
      notes: ["OSM geometry unavailable. Yardage-only fallback used."],
    },
    attribution: ATTRIBUTION,
  };
}

function buildStoredAiCaddyResponse(storedGeometry, options) {
  const userPoint = [options.lng, options.lat];
  const green = storedGreen(storedGeometry);

  if (!green) {
    return missingResponse({ input: options });
  }

  const route = parseJsonValue(storedGeometry.route_json || storedGeometry.routeJson || storedGeometry.route) || {};
  const bunkers = storedFeatures(storedGeometry.bunkers_json || storedGeometry.bunkersJson || storedGeometry.bunkers, "bunker");
  const waterHazards = storedFeatures(
    storedGeometry.water_json || storedGeometry.waterJson || storedGeometry.water_hazards || storedGeometry.waterHazards,
    "water_hazard",
  );
  const hazardFallback = storedFeatures(
    storedGeometry.hazards_json || storedGeometry.hazardsJson || storedGeometry.hazards,
    "hazard",
  );
  const nearestBunkers = nearestStoredFeatures(
    bunkers.length ? bunkers : hazardFallback.filter((feature) => feature.type === "bunker"),
    userPoint,
    options.maxHazards,
  );
  const nearestWaterHazards = nearestStoredFeatures(
    waterHazards.length ? waterHazards : hazardFallback.filter((feature) => feature.type !== "bunker"),
    userPoint,
    options.maxHazards,
  );
  const geometryStatus = normalizeGeometryStatus(storedGeometry.geometry_status || storedGeometry.geometryStatus);
  const mappingStatus = geometryStatus === "partial" ? "partial" : "full";

  return {
    ok: true,
    mapping_status: mappingStatus,
    geometry_available: true,
    fallback_mode: mappingStatus === "partial" ? "partial_geometry" : null,
    course: {
      name: options.courseName || null,
      osm_id: options.courseOsmId || null,
      attribution: ATTRIBUTION,
    },
    hole: options.hole,
    selected_tee_name: options.selectedTeeName || null,
    current_yardage: options.currentYardage,
    green: {
      osm_id: green.osm_id || storedGeometry.green_osm_id || storedGeometry.greenOsmId || "",
      center: green.center,
      distance_from_user_yards: yardsBetween(userPoint, [green.center.lng, green.center.lat]),
      match: green.match || null,
    },
    nearest_bunkers: nearestBunkers,
    nearest_water_hazards: nearestWaterHazards,
    route,
    data_quality: {
      confidence: mappingStatus === "full" ? "high" : "medium",
      boundary_available: false,
      hole_route_found: Boolean(route?.osm_id || storedGeometry.route_osm_id || storedGeometry.routeOsmId),
      green_found: true,
      notes: storedQualityNotes(storedGeometry, mappingStatus),
    },
    attribution: ATTRIBUTION,
  };
}

function parseStoredHoleGeometry(value) {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object") return null;

  const geometryStatus = normalizeGeometryStatus(parsed.geometry_status || parsed.geometryStatus);
  if (geometryStatus === "missing") return null;

  return parsed;
}

function storedGreen(storedGeometry) {
  const greenJson = parseJsonValue(storedGeometry.green_json || storedGeometry.greenJson || storedGeometry.green) || {};
  const greenLat = finiteNumber(storedGeometry.green_lat ?? storedGeometry.greenLat ?? greenJson.center?.lat);
  const greenLng = finiteNumber(storedGeometry.green_lng ?? storedGeometry.greenLng ?? greenJson.center?.lng);

  if (!Number.isFinite(greenLat) || !Number.isFinite(greenLng)) return null;

  return {
    ...greenJson,
    osm_id: greenJson.osm_id || storedGeometry.green_osm_id || storedGeometry.greenOsmId || "",
    center: {
      lat: roundCoord(greenLat),
      lng: roundCoord(greenLng),
    },
  };
}

function storedFeatures(value, fallbackType) {
  const parsed = parseJsonValue(value);
  const list = Array.isArray(parsed) ? parsed : [];

  return list
    .map((feature) => normalizeStoredFeature(feature, fallbackType))
    .filter(Boolean);
}

function normalizeStoredFeature(feature, fallbackType) {
  if (!feature || typeof feature !== "object") return null;

  const lat = finiteNumber(feature.center?.lat ?? feature.lat);
  const lng = finiteNumber(feature.center?.lng ?? feature.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    type: feature.type || fallbackType,
    osm_id: feature.osm_id || "",
    center: {
      lat: roundCoord(lat),
      lng: roundCoord(lng),
    },
    match: feature.match || null,
  };
}

function nearestStoredFeatures(features, userPoint, maxCount) {
  return features
    .map((feature) => ({
      type: outputHazardType(feature.type),
      osm_id: feature.osm_id,
      center: feature.center,
      distance_from_user_yards: yardsBetween(userPoint, [feature.center.lng, feature.center.lat]),
      match: feature.match || null,
    }))
    .sort((a, b) => a.distance_from_user_yards - b.distance_from_user_yards)
    .slice(0, maxCount);
}

function storedQualityNotes(storedGeometry, mappingStatus) {
  const parsed = parseJsonValue(storedGeometry.quality_notes_json || storedGeometry.qualityNotesJson);
  if (Array.isArray(parsed) && parsed.length) return parsed;
  return mappingStatus === "full"
    ? ["Stored course geometry used."]
    : ["Stored partial course geometry used."];
}

function normalizeGeometryStatus(value) {
  const status = String(value || "").toLowerCase();
  if (status === "full" || status === "partial") return status;
  return "missing";
}

function parseJsonValue(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function buildBubbleGeometryResponse({ input, geometry, attemptedAt }) {
  const holeRecords = geometry.holeRefsFound.map((holeNumber) =>
    buildBubbleHoleGeometryRecord({
      geometry,
      holeNumber,
      updatedAt: attemptedAt,
    }),
  );
  const mappingStatus = classifyCourseGeometryStatus(holeRecords, geometry);
  const geometryAvailable = mappingStatus !== "missing";
  const builtAt = attemptedAt;

  return {
    ok: true,
    build_status: "ready",
    mapping_status: mappingStatus,
    geometry_available: geometryAvailable,
    course_key: input.courseKey,
    course_id: input.courseId || null,
    course_geometry: {
      course_key: input.courseKey,
      course_name: geometry.course.tags?.name || input.courseName || null,
      osm_id: osmId(geometry.course),
      mapping_status: mappingStatus,
      build_status: "ready",
      geometry_available: geometryAvailable,
      source: "osm",
      attribution: ATTRIBUTION,
      features_count_json: stringifyJson(geometry.featureCounts),
      hole_refs_found_json: stringifyJson(geometry.holeRefsFound),
      quality_notes_json: stringifyJson(courseQualityNotes(mappingStatus, holeRecords)),
      raw_course_json: stringifyJson(rawCourseForBubble(geometry)),
      build_error: "",
      last_build_attempt_at: attemptedAt,
      built_at: builtAt,
    },
    course_hole_geometries: holeRecords,
    attribution: ATTRIBUTION,
  };
}

function buildBubbleGeometryFallback({ input, attemptedAt, buildError }) {
  return {
    ok: true,
    build_status: "failed",
    mapping_status: "missing",
    geometry_available: false,
    course_key: input.courseKey,
    course_id: input.courseId || null,
    course_geometry: {
      course_key: input.courseKey,
      course_name: input.courseName || null,
      osm_id: "",
      mapping_status: "missing",
      build_status: "failed",
      geometry_available: false,
      source: "osm",
      attribution: ATTRIBUTION,
      features_count_json: "{}",
      hole_refs_found_json: "[]",
      quality_notes_json: stringifyJson(["OSM geometry unavailable. Yardage-only fallback should be used."]),
      raw_course_json: "{}",
      build_error: buildError || "osm_geometry_unavailable",
      last_build_attempt_at: attemptedAt,
      built_at: null,
    },
    course_hole_geometries: [],
    attribution: ATTRIBUTION,
  };
}

function buildBubbleHoleGeometryRecord({ geometry, holeNumber, updatedAt }) {
  const holeRecord = geometry.holeMap.get(holeNumber) || { holeRoutes: [], features: [] };
  const holeRoutes = holeRecord.holeRoutes || [];
  const primaryRoute = holeRoutes[0] || null;
  const features = holeRecord.features || [];
  const greens = features.filter((feature) => feature.kind === "green");
  const tees = features.filter((feature) => feature.kind === "tee");
  const bunkers = features.filter((feature) => feature.kind === "bunker");
  const waterHazards = features.filter((feature) => isWaterKind(feature.kind));
  const fairways = features.filter((feature) => feature.kind === "fairway");
  const primaryGreen = pickPrimaryGreen(greens, primaryRoute);
  const geometryStatus = classifyHoleGeometryStatus({
    holeRecord,
    primaryRoute,
    primaryGreen,
    features,
  });
  const green = primaryGreen ? bubbleFeature(primaryGreen) : null;
  const route = primaryRoute ? bubbleRoute(primaryRoute) : null;
  const teeRecords = tees.map((feature) => bubbleFeature(feature));
  const bunkerRecords = bunkers.map((feature) => ({ type: "bunker", ...bubbleFeature(feature) }));
  const waterRecords = waterHazards.map((feature) => ({ type: outputHazardType(feature.kind), ...bubbleFeature(feature) }));
  const fairwayRecords = fairways.map((feature) => bubbleFeature(feature));
  const hazardRecords = [...bunkerRecords, ...waterRecords];
  const notes =
    geometryStatus === "missing"
      ? ["No usable OSM geometry found for this hole."]
      : qualityNotes(geometry, { hole: holeNumber }, primaryRoute, primaryGreen);

  return {
    hole_number: holeNumber,
    hole_ref: primaryRoute?.element.tags?.ref || String(holeNumber),
    green_lat: primaryGreen ? roundCoord(primaryGreen.center[1]) : null,
    green_lng: primaryGreen ? roundCoord(primaryGreen.center[0]) : null,
    green_osm_id: primaryGreen ? osmId(primaryGreen.element) : "",
    route_osm_id: primaryRoute ? osmId(primaryRoute.element) : "",
    route_json: stringifyJson(route || {}),
    tees_json: stringifyJson(teeRecords),
    bunkers_json: stringifyJson(bunkerRecords),
    water_json: stringifyJson(waterRecords),
    hazards_json: stringifyJson(hazardRecords),
    fairway_json: stringifyJson(fairwayRecords),
    green_json: stringifyJson(green || {}),
    geometry_status: geometryStatus,
    quality_notes_json: stringifyJson(notes),
    last_updated_at: updatedAt,
  };
}

function classifyCourseGeometryStatus(holeRecords, geometry) {
  const usefulFeatureCount = Object.entries(geometry.featureCounts)
    .filter(([kind]) => kind !== "other")
    .reduce((total, [, count]) => total + count, 0);

  if (!usefulFeatureCount || !holeRecords.length) return "missing";

  const fullHoles = new Set(
    holeRecords.filter((record) => record.geometry_status === "full").map((record) => record.hole_number),
  );
  const hasFullFrontNine = Array.from({ length: 9 }, (_, index) => index + 1).every((hole) => fullHoles.has(hole));
  const hasFullEighteen = Array.from({ length: 18 }, (_, index) => index + 1).every((hole) => fullHoles.has(hole));

  if (hasFullEighteen || hasFullFrontNine) return "full";
  if (holeRecords.some((record) => record.geometry_status !== "missing")) return "partial";
  return "missing";
}

function classifyHoleGeometryStatus({ holeRecord, primaryRoute, primaryGreen, features }) {
  if (primaryRoute && primaryGreen) return "full";
  if (holeRecord && (primaryRoute || primaryGreen || features.length > 0)) return "partial";
  return "missing";
}

function courseQualityNotes(mappingStatus, holeRecords) {
  if (mappingStatus === "full") {
    return ["Course geometry built from OSM.", "All primary hole geometry found for a complete 9 or 18 hole set."];
  }

  if (mappingStatus === "partial") {
    return ["Course geometry built from OSM.", "Some hole geometry is incomplete."];
  }

  return ["Course found in OSM, but no usable hole-level geometry was found."];
}

function rawCourseForBubble(geometry) {
  return {
    name: geometry.course.tags?.name || null,
    osm_id: osmId(geometry.course),
    center: courseCenter(geometry.course),
    boundary_available: isClosedRing(geometry.courseBoundary),
    tags: geometry.course.tags || {},
  };
}

function bubbleRoute(route) {
  return {
    osm_id: osmId(route.element),
    ref: String(route.ref),
    par: route.element.tags?.par || null,
    coordinates: route.line.map(([lng, lat]) => ({ lat: roundCoord(lat), lng: roundCoord(lng) })),
  };
}

function bubbleFeature(feature) {
  return {
    osm_id: osmId(feature.element),
    center: latLng(feature.center),
    match: feature.match || null,
  };
}

function stringifyJson(value) {
  return JSON.stringify(value);
}

async function fetchCourseByOsmId({ type, id }) {
  const stage = "fetchCourseByOsmId";
  const started = Date.now();
  console.log("[geometry-build] stage:fetchCourseByOsmId start", {
    osm_id: `${type}/${id}`,
  });

  const query = `
    [out:json][timeout:60];
    (
      ${type}(${id});
    );
    out tags center;
  `;

  const data = await overpass(query, stage);
  console.log("[geometry-build] stage:fetchCourseByOsmId success", {
    osm_id: `${type}/${id}`,
    elapsed_ms: Date.now() - started,
    elements: data.elements?.length || 0,
  });

  return (data.elements || [])[0] || null;
}

async function findCourseByName({ courseName, lat, lng, searchRadiusMeters }) {
  const stage = "findCourseByName";
  const started = Date.now();
  console.log("[geometry-build] stage:findCourseByName start", {
    course_name: courseName,
    lat,
    lng,
    search_radius_meters: searchRadiusMeters,
  });

  const escaped = escapeOverpassRegex(courseName);
  const query = `
    [out:json][timeout:60];
    (
      nwr["leisure"="golf_course"]["name"~"${escaped}",i](around:${searchRadiusMeters},${lat},${lng});
    );
    out tags center geom;
  `;

  const data = await overpass(query, stage);
  const courses = data.elements || [];
  const userPoint = [lng, lat];
  console.log("[geometry-build] stage:findCourseByName success", {
    course_name: courseName,
    elapsed_ms: Date.now() - started,
    candidates: courses.length,
  });

  return courses
    .map((course) => ({
      course,
      score: courseScore(course, courseName, userPoint),
    }))
    .sort((a, b) => b.score - a.score)[0]?.course || null;
}

async function fetchCourseFeatureElements(course, { featureRadiusMeters }) {
  const stage = "fetchCourseFeatureElements";
  const started = Date.now();
  const center = courseCenter(course);
  console.log("[geometry-build] stage:fetchCourseFeatureElements start", {
    osm_id: osmId(course),
    center,
    feature_radius_meters: featureRadiusMeters,
  });

  const elements = [];
  const remainingBudgetMs = () => Math.max(0, OVERPASS_TIMEOUT_MS - (Date.now() - started));
  const runFeatureQuery = async (name, query) => {
    const timeoutMs = remainingBudgetMs();
    if (timeoutMs <= 0) {
      console.log("[geometry-build] stage:fetchCourseFeatureElements query_skipped", {
        query: name,
        osm_id: osmId(course),
        reason: "total_budget_exhausted",
      });
      return null;
    }

    const queryStarted = Date.now();
    console.log("[geometry-build] stage:fetchCourseFeatureElements query_start", {
      query: name,
      osm_id: osmId(course),
      remaining_budget_ms: timeoutMs,
    });

    try {
      const data = await overpass(query, `${stage}:${name}`, timeoutMs);
      const queryElements = data.elements || [];
      elements.push(...queryElements);
      console.log("[geometry-build] stage:fetchCourseFeatureElements query_success", {
        query: name,
        osm_id: osmId(course),
        elapsed_ms: Date.now() - queryStarted,
        elements: queryElements.length,
      });
      return queryElements;
    } catch (error) {
      console.log("[geometry-build] stage:fetchCourseFeatureElements query_failed", {
        query: name,
        osm_id: osmId(course),
        elapsed_ms: Date.now() - queryStarted,
        error: readableError(error),
      });
    }

    return [];
  };

  await runFeatureQuery(
    "golf_greens",
    `
      [out:json][timeout:90];
      nwr["golf"="green"](around:${featureRadiusMeters},${center.lat},${center.lng});
      out body geom;
    `,
  );

  const allHoleElements =
    (await runFeatureQuery(
      "golf_holes",
      `
        [out:json][timeout:90];
        way["golf"="hole"](around:${featureRadiusMeters},${center.lat},${center.lng});
        out geom;
      `,
    )) || [];
  const foundHoleRefs = new Set(validHoleRefsFromElements(allHoleElements).filter((ref) => ref >= 1 && ref <= 18));
  console.log("[geometry-build] stage:fetchCourseFeatureElements golf_holes_refs", {
    osm_id: osmId(course),
    hole_refs_found: [...foundHoleRefs].sort((a, b) => a - b),
  });

  for (let holeRef = 1; holeRef <= 18; holeRef += 1) {
    if (foundHoleRefs.has(holeRef)) continue;

    const queryElements = await runFeatureQuery(
      `golf_hole_ref_${holeRef}`,
      `
        [out:json][timeout:90];
        way["golf"="hole"]["ref"="${holeRef}"](around:${featureRadiusMeters},${center.lat},${center.lng});
        out geom;
      `,
    );
    if (queryElements === null || remainingBudgetMs() <= 0) break;
  }

  console.log("[geometry-build] stage:fetchCourseFeatureElements success", {
    osm_id: osmId(course),
    elapsed_ms: Date.now() - started,
    elements: elements.length,
  });

  return elements;
}

async function overpass(query, stage = "overpass", timeoutMs = OVERPASS_TIMEOUT_MS) {
  const controller = new AbortController();
  const started = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  console.log("[geometry-build] stage:overpass start", {
    stage,
    timeout_ms: timeoutMs,
  });

  try {
    const response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "user-agent": "Golf Trackr AI Caddy OSM Geometry API",
      },
      body: query,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Overpass request failed with HTTP ${response.status}`);
      error.status = response.status;
      error.responseBody = body.slice(0, 300);
      error.stage = stage;
      console.log("[geometry-build] stage:overpass http_error", {
        stage,
        status: response.status,
        elapsed_ms: Date.now() - started,
      });
      throw error;
    }

    const data = await response.json();
    console.log("[geometry-build] stage:overpass success", {
      stage,
      elapsed_ms: Date.now() - started,
      elements: data.elements?.length || 0,
    });
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`Overpass timed out after ${timeoutMs}ms`);
      timeoutError.code = "overpass_timeout";
      timeoutError.stage = stage;
      console.log("[geometry-build] stage:overpass timeout", {
        stage,
        elapsed_ms: Date.now() - started,
        timeout_ms: timeoutMs,
      });
      throw timeoutError;
    }

    console.log("[geometry-build] stage:overpass error", {
      stage: error.stage || stage,
      elapsed_ms: Date.now() - started,
      error: readableError(error),
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function ensureHoleRecord(holeMap, ref) {
  if (!holeMap.has(ref)) {
    holeMap.set(ref, { holeRoutes: [], features: [] });
  }

  return holeMap.get(ref);
}

function pickPrimaryGreen(greens, primaryRoute) {
  if (!greens.length) return null;

  const directMatch = greens.find((green) => green.match?.method === "feature_ref");
  if (directMatch) return directMatch;

  if (!primaryRoute) return greens[0];

  const routeEnd = primaryRoute.line[primaryRoute.line.length - 1];
  return [...greens].sort((a, b) => distanceMeters(routeEnd, a.center) - distanceMeters(routeEnd, b.center))[0];
}

function nearestFeatures(features, userPoint, maxCount) {
  return features
    .map((feature) => ({
      type: outputHazardType(feature.kind),
      osm_id: osmId(feature.element),
      center: latLng(feature.center),
      distance_from_user_yards: yardsBetween(userPoint, feature.center),
      match: feature.match || null,
    }))
    .sort((a, b) => a.distance_from_user_yards - b.distance_from_user_yards)
    .slice(0, maxCount);
}

function validHoleRefsFromElements(elements) {
  return [
    ...new Set(
      (elements || [])
        .filter((element) => element.tags?.golf === "hole" && getGeometry(element).length > 1)
        .map((element) => numericRef(element.tags?.ref))
        .filter(Number.isFinite),
    ),
  ];
}

function qualityNotes(geometry, options, primaryRoute, primaryGreen) {
  const notes = [];
  const routesForHole = geometry.holeMap.get(options.hole)?.holeRoutes || [];

  if (routesForHole.length > 1) {
    notes.push(`Multiple OSM hole routes found for hole ${options.hole}; first route used.`);
  }

  if (!primaryRoute) {
    notes.push("No OSM hole route found for this hole.");
  }

  if (!primaryGreen) {
    notes.push("No OSM green found for this hole.");
  }

  if (!notes.length) {
    notes.push("Hole route and green were found.");
  }

  return notes;
}

function knownCourseForName(courseName) {
  const normalized = normalizeName(courseName);
  return KNOWN_COURSES.find((course) => course.match.some((name) => normalized.includes(name))) || null;
}

function parseOsmId(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(node|way|relation)\/(\d+)$/i);
  return match ? { type: match[1].toLowerCase(), id: Number(match[2]) } : null;
}

function minimalCourseFromExplicitOsmId({ type, id }, options) {
  const course = {
    type,
    id,
    tags: {
      name: options.courseName || null,
      leisure: "golf_course",
    },
  };

  if (Number.isFinite(options.lat) && Number.isFinite(options.lng)) {
    course.center = {
      lat: options.lat,
      lon: options.lng,
    };
  }

  return course;
}

function courseSummary(course) {
  return {
    name: course.tags?.name || null,
    osm_id: osmId(course),
    center: courseCenter(course),
    attribution: ATTRIBUTION,
  };
}

function escapeOverpassRegex(value) {
  return String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/&/g, "(&|and)");
}

function courseScore(course, courseName, userPoint) {
  const name = normalizeName(course.tags?.name || "");
  const wanted = normalizeName(courseName);
  const nameScore = name === wanted ? 1000 : name.includes(wanted) || wanted.includes(name) ? 500 : 0;
  return nameScore - distanceMeters(userPoint, [courseCenter(course).lng, courseCenter(course).lat]) / 1000;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();
}

function isWantedFeature(element) {
  const tags = element.tags || {};
  return Boolean(tags.golf || tags.natural === "water" || tags.water);
}

function featureKind(element) {
  const tags = element.tags || {};
  if (tags.golf) return tags.golf;
  if (tags.natural === "water" || tags.water) return "water";
  return "other";
}

function isWaterKind(kind) {
  return kind === "water" || kind === "water_hazard" || kind === "lateral_water_hazard";
}

function outputHazardType(kind) {
  return isWaterKind(kind) ? "water_hazard" : kind;
}

function getGeometry(element) {
  if (element.geometry) return element.geometry.map(({ lon, lat }) => [lon, lat]);
  if (element.center) return [[element.center.lon, element.center.lat]];
  if (Number.isFinite(element.lon) && Number.isFinite(element.lat)) return [[element.lon, element.lat]];
  return [];
}

function courseCenter(course) {
  if (course.center) return { lat: roundCoord(course.center.lat), lng: roundCoord(course.center.lon) };

  const center = centroid(course);
  return center
    ? { lat: roundCoord(center[1]), lng: roundCoord(center[0]) }
    : { lat: null, lng: null };
}

function centroid(element) {
  const coords = getGeometry(element);
  if (!coords.length) return null;

  const polygon = coords.length > 3 && isClosedRing(coords) && element.tags?.golf !== "hole";
  return polygon ? polygonCentroid(coords) : averagePoint(coords);
}

function averagePoint(coords) {
  const sum = coords.reduce((acc, coord) => [acc[0] + coord[0], acc[1] + coord[1]], [0, 0]);
  return [sum[0] / coords.length, sum[1] / coords.length];
}

function polygonCentroid(ring) {
  const coords = isClosedRing(ring) ? ring.slice(0, -1) : ring;
  let area = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const [x0, y0] = coords[j];
    const [x1, y1] = coords[i];
    const factor = x0 * y1 - x1 * y0;
    area += factor;
    cx += (x0 + x1) * factor;
    cy += (y0 + y1) * factor;
  }

  area *= 0.5;
  if (Math.abs(area) < 1e-18) return averagePoint(coords);
  return [cx / (6 * area), cy / (6 * area)];
}

function isClosedRing(coords) {
  if (coords.length < 4) return false;
  const first = coords[0];
  const last = coords[coords.length - 1];
  return Math.abs(first[0] - last[0]) < 1e-12 && Math.abs(first[1] - last[1]) < 1e-12;
}

function pointInRing(point, ring) {
  let inside = false;
  const [x, y] = point;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-30) + xi;
    if (intersects) inside = !inside;
  }

  return inside;
}

function nearestHole(point, holes, maxMeters) {
  let best = null;
  let bestMeters = Infinity;

  for (const hole of holes) {
    const meters = pointToLineMeters(point, hole.line);
    if (meters < bestMeters) {
      best = hole;
      bestMeters = meters;
    }
  }

  return best && bestMeters <= maxMeters ? { hole: best, meters: Math.round(bestMeters) } : null;
}

function pointToLineMeters(point, line) {
  let best = Infinity;

  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, pointToSegmentMeters(point, line[i - 1], line[i]));
  }

  return best;
}

function pointToSegmentMeters(point, start, end) {
  const [px, py] = project(point);
  const [sx, sy] = project(start);
  const [ex, ey] = project(end);
  const dx = ex - sx;
  const dy = ey - sy;

  if (dx === 0 && dy === 0) return Math.hypot(px - sx, py - sy);

  const t = Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (sx + t * dx), py - (sy + t * dy));
}

function project([lng, lat]) {
  const metersPerLat = 111320;
  const metersPerLng = 111320 * Math.cos((lat * Math.PI) / 180);
  return [lng * metersPerLng, lat * metersPerLat];
}

function distanceMeters(a, b) {
  const radius = 6371008.8;
  const radians = Math.PI / 180;
  const dLat = (b[1] - a[1]) * radians;
  const dLng = (b[0] - a[0]) * radians;
  const lat1 = a[1] * radians;
  const lat2 = b[1] * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function yardsBetween(a, b) {
  return Math.round(distanceMeters(a, b) * YARDS_PER_METER);
}

function numericRef(ref) {
  if (!ref) return NaN;
  const match = String(ref).match(/\d+/);
  return match ? Number(match[0]) : NaN;
}

function latLng([lng, lat]) {
  return { lat: roundCoord(lat), lng: roundCoord(lng) };
}

function roundCoord(value) {
  return Number.isFinite(value) ? Math.round(value * 1e7) / 1e7 : null;
}

function osmId(element) {
  return `${element.type}/${element.id}`;
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = item[key];
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function withLog(response, log) {
  response._log = log;
  return response;
}

function readableError(error) {
  if (!error) return "unknown_error";
  if (error.status) return `HTTP ${error.status}`;
  if (error.code) return error.code;
  return error.message || "unknown_error";
}
