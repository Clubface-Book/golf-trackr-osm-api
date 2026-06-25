const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const NOMINATIM_SEARCH_URL = process.env.NOMINATIM_SEARCH_URL || "https://nominatim.openstreetmap.org/search";
const OVERPASS_TIMEOUT_MS = Number(process.env.OVERPASS_TIMEOUT_MS || 120000);
const YARDS_PER_METER = 1.0936132983377078;
const DEFAULT_CACHE_TTL_MS = Number(process.env.COURSE_CACHE_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const DEFAULT_SEARCH_RADIUS_METERS = Number(process.env.SEARCH_RADIUS_METERS || 5000);
const DEFAULT_FEATURE_RADIUS_METERS = Number(process.env.FEATURE_RADIUS_METERS || 1200);
const DEFAULT_HOLE_MATCH_METERS = Number(process.env.HOLE_MATCH_METERS || 100);
const DEFAULT_BUILD_HOLE_MATCH_METERS = Number(process.env.BUILD_HOLE_MATCH_METERS || 300);
const DEFAULT_MAX_HAZARDS = Number(process.env.MAX_HAZARDS || 3);
const NOMINATIM_LOOKUP_DELAY_MS = Number(process.env.NOMINATIM_LOOKUP_DELAY_MS || 1000);
const OVERPASS_RETRY_DELAYS_MS = [2000, 5000];
const OVERPASS_RETRYABLE_STATUSES = new Set([429, 504]);
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
  if (storedGeometry) {
    const response = buildStoredAiCaddyResponse(storedGeometry, options);
    return withLog(response, {
      geometry_source: response.fallback_mode ? "fallback" : "stored_hole_geometry",
      fallback_reason: response.fallback_mode ? "stored_hole_geometry_incomplete" : null,
    });
  }

  const cachedGeometry = cachedCourseGeometryForAiCaddy(options);
  if (cachedGeometry) {
    const response = buildAiCaddyResponse(cachedGeometry, options);
    return withLog(response, {
      geometry_source: response.fallback_mode ? "fallback" : "course_cache",
      fallback_reason: response.fallback_mode ? "cached_course_geometry_incomplete" : null,
    });
  }

  return withLog(
    missingResponse({ input: options }),
    {
      geometry_source: "none",
      fallback_reason: "stored_hole_geometry_missing_or_invalid",
    },
  );
}

export async function lookupCourseOsmForBubble(input) {
  const queryVariants = osmLookupQueryVariants(input);
  const matchesByOsmId = new Map();
  const queryErrors = [];

  for (let index = 0; index < queryVariants.length; index += 1) {
    const query = queryVariants[index];
    if (index > 0 && NOMINATIM_LOOKUP_DELAY_MS > 0) {
      await delay(NOMINATIM_LOOKUP_DELAY_MS);
    }

    try {
      const results = await searchNominatim(query);
      for (const result of results) {
        const scored = scoreNominatimCourseResult(result, input, query);
        const key = scored.osm_id || `${scored.osm_type}/${scored.osm_numeric_id}`;
        const existing = matchesByOsmId.get(key);
        if (!existing || scored.score > existing.score) {
          matchesByOsmId.set(key, scored);
        }
      }
    } catch (error) {
      queryErrors.push({
        query,
        error: readableError(error),
      });
    }

    const bestSoFar = bestLookupMatch([...matchesByOsmId.values()]);
    if (bestSoFar?.confidence === "high") break;
  }

  const possibleMatches = [...matchesByOsmId.values()].sort((a, b) => b.score - a.score);
  const best = bestLookupMatch(possibleMatches);
  const found = Boolean(best && best.confidence !== "low");

  if (!found) {
    return {
      found: false,
      osm_id: null,
      osm_type: null,
      osm_numeric_id: null,
      name: "",
      display_name: "",
      lat: null,
      lng: null,
      class: "",
      type: "",
      confidence: "low",
      reason: queryErrors.length
        ? "No confident OSM golf course match found. Some lookup queries failed."
        : "No confident OSM golf course match found.",
      query_used: "",
      possible_matches: possibleMatches.slice(0, 5).map(publicLookupMatch),
    };
  }

  return {
    found: true,
    ...publicLookupMatch(best),
    possible_matches: possibleMatches
      .filter((match) => match.osm_id !== best.osm_id)
      .slice(0, 5)
      .map(publicLookupMatch),
  };
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
    holeMatchMeters: DEFAULT_BUILD_HOLE_MATCH_METERS,
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

function cachedCourseGeometryForAiCaddy(options) {
  const explicitOsmId = parseOsmId(options.courseOsmId);
  if (explicitOsmId) {
    const cached = cachedCourseGeometryByKey(`course:${explicitOsmId.type}/${explicitOsmId.id}`);
    if (cached) return cached;
  }

  const knownCourse = knownCourseForName(options.courseName);
  if (knownCourse) {
    const cached = cachedCourseGeometryByKey(`course:${knownCourse.osmType}/${knownCourse.osmId}`);
    if (cached) return cached;
  }

  const wantedName = normalizeName(options.courseName);
  if (!wantedName) return null;

  for (const [key, cached] of courseCache.entries()) {
    if (!cached || cached.expiresAt <= Date.now()) continue;

    const courseName = normalizeName(cached.value?.course?.tags?.name);
    if (!courseName) continue;

    if (courseName === wantedName || courseName.includes(wantedName) || wantedName.includes(courseName)) {
      return {
        ...cached.value,
        cache: {
          status: "hit",
          key,
          expires_at: new Date(cached.expiresAt).toISOString(),
        },
      };
    }
  }

  return null;
}

function cachedCourseGeometryByKey(key) {
  const cached = courseCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) return null;

  return {
    ...cached.value,
    cache: {
      status: "hit",
      key,
      expires_at: new Date(cached.expiresAt).toISOString(),
    },
  };
}

async function buildCourseGeometry(course, options) {
  const featureResult = await fetchCourseFeatureElements(course, options);
  const rawElements = featureResult.elements || [];
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
    queryStatuses: featureResult.queryStatuses || {},
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
  const greenDistanceFromUserYards = primaryGreen ? yardsBetween(userPoint, primaryGreen.center) : null;
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

  console.log("[ai-caddy] course_cache_distance_debug", {
    incoming_lat: options.lat,
    incoming_lng: options.lng,
    user_lat: options.lat,
    user_lng: options.lng,
    cached_green_lat: primaryGreen ? roundCoord(primaryGreen.center[1]) : null,
    cached_green_lng: primaryGreen ? roundCoord(primaryGreen.center[0]) : null,
    calculated_green_distance_from_user_yards: greenDistanceFromUserYards,
    green_distance_included_in_response: Boolean(primaryGreen && Number.isFinite(greenDistanceFromUserYards)),
  });

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
          distance_from_user_yards: greenDistanceFromUserYards,
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
  const routeCoordinates = Array.isArray(route.coordinates)
    ? route.coordinates
        .map((point) => [finiteNumber(point.lng), finiteNumber(point.lat)])
        .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
    : [];
  const teePoint = routeCoordinates[0] || null;
  const greenPoint = [green.center.lng, green.center.lat];
  const bunkers = storedFeatures(storedGeometry.bunkers_json || storedGeometry.bunkersJson || storedGeometry.bunkers, "bunker");
  const waterHazards = storedFeatures(
    storedGeometry.water_json || storedGeometry.waterJson || storedGeometry.water_hazards || storedGeometry.waterHazards,
    "water_hazard",
  );
  const hazardFallback = storedFeatures(
    storedGeometry.hazards_json || storedGeometry.hazardsJson || storedGeometry.hazards,
    "hazard",
  );
  const bunkerFeatures = bunkers.length ? bunkers : hazardFallback.filter((feature) => feature.type === "bunker");
  const waterHazardFeatures = waterHazards.length
    ? waterHazards
    : hazardFallback.filter((feature) => feature.type !== "bunker");
  const nearestBunkers = nearestStoredFeatures(bunkerFeatures, userPoint, options.maxHazards);
  const nearestWaterHazards = nearestStoredFeatures(waterHazardFeatures, userPoint, options.maxHazards);
  const geometryStatus = normalizeGeometryStatus(storedGeometry.geometry_status || storedGeometry.geometryStatus);
  const mappingStatus = geometryStatus === "partial" ? "partial" : "full";

  const routeLengthMeters = routeCoordinates.reduce((total, point, index) => {
    if (index === 0) return total;
    return total + distanceMeters(routeCoordinates[index - 1], point);
  }, 0);

  const routeProjection = (point) => {
    if (routeCoordinates.length < 2) return null;

    let best = null;
    let cumulativeMeters = 0;

    for (let index = 1; index < routeCoordinates.length; index += 1) {
      const start = routeCoordinates[index - 1];
      const end = routeCoordinates[index];
      const segmentMeters = distanceMeters(start, end);
      const [px, py] = project(point);
      const [sx, sy] = project(start);
      const [ex, ey] = project(end);
      const dx = ex - sx;
      const dy = ey - sy;

      if (dx === 0 && dy === 0) continue;

      const t = Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy)));
      const projectedX = sx + t * dx;
      const projectedY = sy + t * dy;
      const offsetMeters = Math.hypot(px - projectedX, py - projectedY);
      const cross = dx * (py - sy) - dy * (px - sx);
      const side = Math.abs(cross) < 1e-6 ? "on_route" : cross > 0 ? "left" : "right";

      if (!best || offsetMeters < best.offsetMeters) {
        best = {
          alongMeters: cumulativeMeters + segmentMeters * t,
          offsetMeters,
          side,
        };
      }

      cumulativeMeters += segmentMeters;
    }

    return best;
  };

  const bearingDegrees = (from, to) => {
    const radians = Math.PI / 180;
    const lat1 = from[1] * radians;
    const lat2 = to[1] * radians;
    const deltaLng = (to[0] - from[0]) * radians;
    const y = Math.sin(deltaLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
    return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
  };

  const compassLabel = (degrees) => {
    const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return labels[Math.round(degrees / 45) % labels.length];
  };

  const playerProjection = routeProjection(userPoint);
  const playerProgressAlongHole =
    playerProjection && routeLengthMeters > 0
      ? {
          available: true,
          distance_from_tee_yards: Math.round(playerProjection.alongMeters * YARDS_PER_METER),
          distance_to_green_yards: yardsBetween(userPoint, greenPoint),
          distance_from_route_yards: Math.round(playerProjection.offsetMeters * YARDS_PER_METER),
          percent_complete: Math.max(0, Math.min(100, Math.round((playerProjection.alongMeters / routeLengthMeters) * 100))),
        }
      : {
          available: false,
          reason: "route_geometry_unavailable",
        };

  const teeToGreenBearing =
    teePoint && greenPoint
      ? (() => {
          const degrees = bearingDegrees(teePoint, greenPoint);
          return {
            available: true,
            degrees,
            compass: compassLabel(degrees),
          };
        })()
      : {
          available: false,
          reason: "route_geometry_unavailable",
        };

  const enrichHazard = (feature) => {
    const centerPoint = [feature.center.lng, feature.center.lat];
    const projection = routeProjection(centerPoint);
    const teeToHazardYards = projection
      ? Math.round(projection.alongMeters * YARDS_PER_METER)
      : teePoint
        ? yardsBetween(teePoint, centerPoint)
        : null;
    const routeOffsetYards = projection ? Math.round(projection.offsetMeters * YARDS_PER_METER) : null;
    const positionAlongHolePercent =
      projection && routeLengthMeters > 0
        ? Math.max(0, Math.min(100, Math.round((projection.alongMeters / routeLengthMeters) * 100)))
        : null;

    return {
      type: outputHazardType(feature.type),
      osm_id: feature.osm_id,
      center: feature.center,
      distance_from_user_yards: yardsBetween(userPoint, centerPoint),
      tee_to_hazard_yards: teeToHazardYards,
      green_to_hazard_yards: yardsBetween(centerPoint, greenPoint),
      side_of_route: projection?.side || "unknown",
      route_offset_yards: routeOffsetYards,
      position_along_hole_percent: positionAlongHolePercent,
      match: feature.match || null,
      _along_meters: projection?.alongMeters ?? null,
    };
  };

  const publicHazard = ({ _along_meters, ...hazard }) => hazard;
  const maxStrategicHazards = options.maxHazards || DEFAULT_MAX_HAZARDS;
  const strategicBunkers = bunkerFeatures.map(enrichHazard);
  const strategicWaterHazards = waterHazardFeatures.map(enrichHazard);
  const strategicHazards = [...strategicBunkers, ...strategicWaterHazards];

  const greensideBunkers = strategicBunkers
    .filter((hazard) => hazard.green_to_hazard_yards <= 60)
    .sort((a, b) => a.green_to_hazard_yards - b.green_to_hazard_yards)
    .slice(0, maxStrategicHazards)
    .map(publicHazard);

  const leftSideBunkers = strategicBunkers
    .filter((hazard) => hazard.side_of_route === "left" && (hazard.route_offset_yards ?? Infinity) <= 100)
    .sort((a, b) => a.tee_to_hazard_yards - b.tee_to_hazard_yards)
    .slice(0, maxStrategicHazards)
    .map(publicHazard);

  const rightSideBunkers = strategicBunkers
    .filter((hazard) => hazard.side_of_route === "right" && (hazard.route_offset_yards ?? Infinity) <= 100)
    .sort((a, b) => a.tee_to_hazard_yards - b.tee_to_hazard_yards)
    .slice(0, maxStrategicHazards)
    .map(publicHazard);

  const teeShotRelevantHazards = strategicHazards
    .filter(
      (hazard) =>
        (hazard.tee_to_hazard_yards ?? 0) >= 140 &&
        (hazard.tee_to_hazard_yards ?? Infinity) <= 300 &&
        (hazard.route_offset_yards ?? Infinity) <= 100,
    )
    .sort((a, b) => a.tee_to_hazard_yards - b.tee_to_hazard_yards)
    .slice(0, maxStrategicHazards)
    .map(publicHazard);

  const approachRelevantHazards = strategicHazards
    .filter((hazard) => {
      const nearGreen = hazard.green_to_hazard_yards <= 100;
      const aheadOfPlayer = playerProjection && hazard._along_meters !== null && hazard._along_meters >= playerProjection.alongMeters;
      const nearApproachRoute =
        aheadOfPlayer && (hazard.position_along_hole_percent ?? 0) >= 65 && (hazard.route_offset_yards ?? Infinity) <= 100;
      return nearGreen || nearApproachRoute;
    })
    .sort((a, b) => a.green_to_hazard_yards - b.green_to_hazard_yards)
    .slice(0, maxStrategicHazards)
    .map(publicHazard);

  const strategicSummary = [];
  if (playerProgressAlongHole.available) {
    strategicSummary.push(
      `Player is approximately ${playerProgressAlongHole.distance_from_tee_yards} yards from the tee along the stored hole route and ${playerProgressAlongHole.distance_to_green_yards} yards from the green.`,
    );
  }
  if (teeToGreenBearing.available) {
    strategicSummary.push(`Hole appears to play roughly ${teeToGreenBearing.compass} from tee to green.`);
  }
  if (greensideBunkers.length) {
    strategicSummary.push(
      `${greensideBunkers.length} greenside bunker(s) appear within approximately 60 yards of the green, based on stored centre-point geometry.`,
    );
  }
  if (leftSideBunkers.length || rightSideBunkers.length) {
    strategicSummary.push(
      `${leftSideBunkers.length} left-side and ${rightSideBunkers.length} right-side bunker(s) appear near the stored hole route.`,
    );
  }
  if (teeShotRelevantHazards.length) {
    strategicSummary.push(`${teeShotRelevantHazards.length} hazard(s) likely relate to the tee-shot landing area.`);
  }
  if (approachRelevantHazards.length) {
    strategicSummary.push(`${approachRelevantHazards.length} hazard(s) likely relate to the approach or green complex.`);
  }

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
    player_progress_along_hole: playerProgressAlongHole,
    tee_to_green_bearing: teeToGreenBearing,
    greenside_bunkers: greensideBunkers,
    left_side_bunkers: leftSideBunkers,
    right_side_bunkers: rightSideBunkers,
    approach_relevant_hazards: approachRelevantHazards,
    tee_shot_relevant_hazards: teeShotRelevantHazards,
    strategic_summary: strategicSummary,
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
  const featureDetailStatus = classifyFeatureDetailStatus(geometry);
  const buildStatus = mappingStatus === "partial" || hasFailedGeometryQuery(geometry) ? "partial" : "ready";
  const geometryAvailable = mappingStatus !== "missing";
  const builtAt = attemptedAt;

  return {
    ok: true,
    build_status: buildStatus,
    mapping_status: mappingStatus,
    feature_detail_status: featureDetailStatus,
    geometry_available: geometryAvailable,
    course_key: input.courseKey,
    course_id: input.courseId || null,
    course_geometry: {
      course_key: input.courseKey,
      course_name: geometry.course.tags?.name || input.courseName || null,
      osm_id: osmId(geometry.course),
      mapping_status: mappingStatus,
      build_status: buildStatus,
      feature_detail_status: featureDetailStatus,
      geometry_available: geometryAvailable,
      source: "osm",
      attribution: ATTRIBUTION,
      features_count_json: stringifyJson(geometry.featureCounts),
      hole_refs_found_json: stringifyJson(stringifyJson(geometry.holeRefsFound)),
      query_status_json: stringifyJson(geometry.queryStatuses || {}),
      quality_notes_json: stringifyJson(courseQualityNotes(mappingStatus, holeRecords, geometry)),
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
    feature_detail_status: "missing",
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
      query_status_json: "{}",
      feature_detail_status: "missing",
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
  const routeGreenStatus = classifyHoleGeometryStatus({
    holeRecord,
    primaryRoute,
    primaryGreen,
    features,
  });
  const geometryStatus =
    routeGreenStatus === "full" && geometryQueryFailed(geometry, "golf_extra_features") ? "partial" : routeGreenStatus;
  const green = primaryGreen ? bubbleFeature(primaryGreen) : null;
  const route = primaryRoute ? bubbleRoute(primaryRoute) : null;
  const teeRecords = tees.map((feature) => bubbleFeature(feature));
  const bunkerRecords = bunkers.map((feature) => ({ type: "bunker", ...bubbleFeature(feature) }));
  const waterRecords = waterHazards.map((feature) => ({ type: outputHazardType(feature.kind), ...bubbleFeature(feature) }));
  const fairwayRecords = fairways.map((feature) => bubbleFeature(feature));
  const hazardRecords = [...bunkerRecords, ...waterRecords];
  const routeLine = primaryRoute?.line || [];
  const teePoint = routeLine[0] || null;
  const greenPoint = primaryGreen?.center || null;
  const routeLengthMeters = routeLine.reduce((total, point, index) => {
    if (index === 0) return total;
    return total + distanceMeters(routeLine[index - 1], point);
  }, 0);
  const routeProjection = (point) => {
    if (routeLine.length < 2) return null;

    let best = null;
    let cumulativeMeters = 0;

    for (let index = 1; index < routeLine.length; index += 1) {
      const start = routeLine[index - 1];
      const end = routeLine[index];
      const segmentMeters = distanceMeters(start, end);
      const [px, py] = project(point);
      const [sx, sy] = project(start);
      const [ex, ey] = project(end);
      const dx = ex - sx;
      const dy = ey - sy;

      if (dx === 0 && dy === 0) continue;

      const t = Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy)));
      const projectedX = sx + t * dx;
      const projectedY = sy + t * dy;
      const offsetMeters = Math.hypot(px - projectedX, py - projectedY);
      const cross = dx * (py - sy) - dy * (px - sx);
      const side = Math.abs(cross) < 1e-6 ? "on_route" : cross > 0 ? "left" : "right";

      if (!best || offsetMeters < best.offsetMeters) {
        best = {
          alongMeters: cumulativeMeters + segmentMeters * t,
          offsetMeters,
          side,
        };
      }

      cumulativeMeters += segmentMeters;
    }

    return best;
  };
  const enrichStaticHazard = (record) => {
    const centerPoint = [record.center.lng, record.center.lat];
    const projection = routeProjection(centerPoint);
    const teeToHazardYards = projection
      ? Math.round(projection.alongMeters * YARDS_PER_METER)
      : teePoint
        ? yardsBetween(teePoint, centerPoint)
        : null;
    const routeOffsetYards = projection ? Math.round(projection.offsetMeters * YARDS_PER_METER) : null;
    const positionAlongHolePercent =
      projection && routeLengthMeters > 0
        ? Math.max(0, Math.min(100, Math.round((projection.alongMeters / routeLengthMeters) * 100)))
        : null;

    return {
      type: outputHazardType(record.type),
      osm_id: record.osm_id,
      center: record.center,
      tee_to_hazard_yards: teeToHazardYards,
      green_to_hazard_yards: greenPoint ? yardsBetween(centerPoint, greenPoint) : null,
      side_of_route: projection?.side || "unknown",
      route_offset_yards: routeOffsetYards,
      position_along_hole_percent: positionAlongHolePercent,
      match: record.match || null,
    };
  };
  const staticBunkers = bunkerRecords.map(enrichStaticHazard);
  const staticWaterHazards = waterRecords.map(enrichStaticHazard);
  const staticHazards = [...staticBunkers, ...staticWaterHazards];
  const byGreenDistance = (a, b) => (a.green_to_hazard_yards ?? Infinity) - (b.green_to_hazard_yards ?? Infinity);
  const byTeeDistance = (a, b) => (a.tee_to_hazard_yards ?? Infinity) - (b.tee_to_hazard_yards ?? Infinity);
  const nearestBunkers = [...staticBunkers].sort(byGreenDistance).slice(0, DEFAULT_MAX_HAZARDS);
  const nearestWaterHazards = [...staticWaterHazards].sort(byGreenDistance).slice(0, DEFAULT_MAX_HAZARDS);
  const greensideBunkers = staticBunkers
    .filter((hazard) => (hazard.green_to_hazard_yards ?? Infinity) <= 60)
    .sort(byGreenDistance)
    .slice(0, DEFAULT_MAX_HAZARDS);
  const approachRelevantHazards = staticHazards
    .filter((hazard) => {
      const nearGreen = (hazard.green_to_hazard_yards ?? Infinity) <= 100;
      const finalApproach =
        (hazard.position_along_hole_percent ?? 0) >= 65 && (hazard.route_offset_yards ?? Infinity) <= 100;
      return nearGreen || finalApproach;
    })
    .sort(byGreenDistance)
    .slice(0, DEFAULT_MAX_HAZARDS);
  const strategicSummary = [];

  if (greensideBunkers.length) {
    strategicSummary.push(
      `${greensideBunkers.length} greenside bunker(s) appear within approximately 60 yards of the green, based on stored centre-point geometry.`,
    );
  }

  if (approachRelevantHazards.length) {
    strategicSummary.push(
      `${approachRelevantHazards.length} hazard(s) likely relate to the approach or green complex, based on stored centre-point geometry.`,
    );
  }

  if (nearestWaterHazards.length) {
    strategicSummary.push(`${nearestWaterHazards.length} water hazard(s) are stored for this hole.`);
  }

  if (!strategicSummary.length && (staticBunkers.length || staticWaterHazards.length)) {
    strategicSummary.push("Stored hazard geometry is available for this hole, using centre-point approximations.");
  }

  if (!strategicSummary.length) {
    strategicSummary.push("No bunker or water hazard geometry is stored for this hole.");
  }
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
    tees_json_text: stringifyJson(stringifyJson(teeRecords)),
    bunkers_json: stringifyJson(bunkerRecords),
    bunkers_json_text: stringifyJson(stringifyJson(bunkerRecords)),
    water_json: stringifyJson(waterRecords),
    water_json_text: stringifyJson(stringifyJson(waterRecords)),
    hazards_json: stringifyJson(hazardRecords),
    hazards_json_text: stringifyJson(stringifyJson(hazardRecords)),
    fairway_json: stringifyJson(fairwayRecords),
    fairway_json_text: stringifyJson(stringifyJson(fairwayRecords)),
    green_json: stringifyJson(green || {}),
    nearest_bunkers: nearestBunkers,
    nearest_bunkers_json: stringifyJson(stringifyJson(nearestBunkers)),
    nearest_water_hazards: nearestWaterHazards,
    nearest_water_hazards_json: stringifyJson(stringifyJson(nearestWaterHazards)),
    greenside_bunkers: greensideBunkers,
    greenside_bunkers_json: stringifyJson(stringifyJson(greensideBunkers)),
    approach_relevant_hazards: approachRelevantHazards,
    approach_relevant_hazards_json: stringifyJson(stringifyJson(approachRelevantHazards)),
    strategic_summary: strategicSummary,
    strategic_summary_json: stringifyJson(stringifyJson(strategicSummary)),
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
  if (hasFailedGeometryQuery(geometry)) return "partial";

  const fullHoles = new Set(
    holeRecords.filter((record) => record.geometry_status === "full").map((record) => record.hole_number),
  );
  const hasFullFrontNine = Array.from({ length: 9 }, (_, index) => index + 1).every((hole) => fullHoles.has(hole));
  const hasFullEighteen = Array.from({ length: 18 }, (_, index) => index + 1).every((hole) => fullHoles.has(hole));

  if (hasFullEighteen || hasFullFrontNine) return "full";
  if (holeRecords.some((record) => record.geometry_status !== "missing")) return "partial";
  return "missing";
}

function classifyFeatureDetailStatus(geometry) {
  const status = geometry.queryStatuses?.golf_extra_features?.status;
  if (status === "success") return "ready";
  if (status === "failed" || status === "skipped") return "failed";
  return "unknown";
}

function hasFailedGeometryQuery(geometry) {
  return Object.values(geometry.queryStatuses || {}).some((status) => status.status === "failed" || status.status === "skipped");
}

function geometryQueryFailed(geometry, queryName) {
  const status = geometry.queryStatuses?.[queryName]?.status;
  return status === "failed" || status === "skipped";
}

function classifyHoleGeometryStatus({ holeRecord, primaryRoute, primaryGreen, features }) {
  if (primaryRoute && primaryGreen) return "full";
  if (holeRecord && (primaryRoute || primaryGreen || features.length > 0)) return "partial";
  return "missing";
}

function courseQualityNotes(mappingStatus, holeRecords, geometry) {
  const notes = [];

  if (mappingStatus === "full") {
    notes.push("Course geometry built from OSM.", "All primary hole geometry found for a complete 9 or 18 hole set.");
  } else if (mappingStatus === "partial") {
    notes.push("Course geometry built from OSM.", "Some hole geometry is incomplete.");
  } else {
    notes.push("Course found in OSM, but no usable hole-level geometry was found.");
  }

  if (geometryQueryFailed(geometry, "golf_extra_features")) {
    notes.push(
      "Routes and greens were found where available, but tees, bunkers, water, fairways, and hazards may be incomplete because the golf_extra_features Overpass query failed.",
    );
  }

  return notes;
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

function osmLookupQueryVariants({ courseName, clubName, town, city, country }) {
  const variants = [
    [courseName, town, country],
    [clubName, town, country],
    [courseName, city, country],
    [clubName, city, country],
    [courseName, country],
    [clubName, country],
  ];
  const seen = new Set();

  return variants
    .map((parts) => parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim())
    .filter((query) => {
      const key = normalizeLookupText(query);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function searchNominatim(query) {
  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Golf Trackr OSM Geometry API course lookup",
    },
  });

  if (!response.ok) {
    const error = new Error(`Nominatim lookup failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function scoreNominatimCourseResult(result, input, queryUsed) {
  const osmType = String(result.osm_type || "").toLowerCase();
  const osmNumericId = String(result.osm_id || "");
  const className = String(result.class || "");
  const type = String(result.type || "");
  const name = String(result.name || "");
  const displayName = String(result.display_name || "");
  const searchableText = normalizeLookupText(`${name} ${displayName}`);
  const isGolfCourse = className === "leisure" && type === "golf_course";
  const isBuilding = className === "building" || result.addresstype === "building";
  const isGolfRelated = searchableText.includes("golf") || className === "leisure" || type.includes("golf");
  const nameScore = lookupNameScore(result, input);
  const locationScore = lookupLocationScore(result, input);
  const osmTypeScore = osmType === "way" || osmType === "relation" ? 40 : 0;
  const kindScore = isGolfCourse ? 1000 : isGolfRelated && !isBuilding ? 500 : 0;
  const buildingPenalty = isBuilding ? 250 : 0;
  const score = kindScore + nameScore + locationScore + osmTypeScore - buildingPenalty;
  const confidence = lookupConfidence({ isGolfCourse, isGolfRelated, isBuilding, nameScore, locationScore });
  const reason =
    confidence === "high"
      ? "Matched an OSM leisure/golf_course result by name and location."
      : confidence === "medium"
        ? "Matched a golf-related result, but it is not a clear high-confidence golf course match."
        : isBuilding
          ? "Result appears to be a building or clubhouse rather than the golf course."
          : "Result is not a confident golf course match.";

  return {
    osm_id: osmType && osmNumericId ? `${osmType}/${osmNumericId}` : null,
    osm_type: osmType || null,
    osm_numeric_id: osmNumericId || null,
    name,
    display_name: displayName,
    lat: finiteNumber(result.lat),
    lng: finiteNumber(result.lon),
    class: className,
    type,
    confidence,
    reason,
    query_used: queryUsed,
    score,
  };
}

function lookupNameScore(result, { courseName, clubName }) {
  const candidate = normalizeLookupText(result.name || result.display_name || "");
  const wantedNames = [courseName, clubName].map(normalizeLookupText).filter(Boolean);
  let best = 0;

  for (const wanted of wantedNames) {
    if (candidate === wanted) best = Math.max(best, 320);
    else if (candidate.includes(wanted) || wanted.includes(candidate)) best = Math.max(best, 220);
    else best = Math.max(best, Math.round(180 * tokenOverlap(candidate, wanted)));
  }

  return best;
}

function lookupLocationScore(result, { town, city, country }) {
  const text = normalizeLookupText(`${result.display_name || ""} ${JSON.stringify(result.address || {})}`);
  const locations = [town, city, country].map(normalizeLookupText).filter(Boolean);
  return locations.reduce((score, value) => score + (text.includes(value) ? 80 : 0), 0);
}

function lookupConfidence({ isGolfCourse, isGolfRelated, isBuilding, nameScore, locationScore }) {
  if (isGolfCourse && nameScore >= 120 && locationScore >= 80) return "high";
  if (isGolfCourse && nameScore >= 80) return "medium";
  if (isGolfRelated && !isBuilding && nameScore >= 80) return "medium";
  return "low";
}

function bestLookupMatch(matches) {
  return matches
    .filter((match) => match.osm_id)
    .sort((a, b) => b.score - a.score)[0] || null;
}

function publicLookupMatch(match) {
  return {
    osm_id: match.osm_id,
    osm_type: match.osm_type,
    osm_numeric_id: match.osm_numeric_id,
    name: match.name,
    display_name: match.display_name,
    lat: match.lat,
    lng: match.lng,
    class: match.class,
    type: match.type,
    confidence: match.confidence,
    reason: match.reason,
    query_used: match.query_used,
  };
}

function normalizeLookupText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenOverlap(a, b) {
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;

  let shared = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) shared += 1;
  }

  return shared / Math.max(aTokens.size, bTokens.size);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  const queryStatuses = {};
  console.log("[geometry-build] stage:fetchCourseFeatureElements start", {
    osm_id: osmId(course),
    center,
    feature_radius_meters: featureRadiusMeters,
  });

  const elements = [];
  const remainingBudgetMs = () => Math.max(0, OVERPASS_TIMEOUT_MS - (Date.now() - started));
  const runFeatureQuery = async (name, query) => {
    const queryStarted = Date.now();
    queryStatuses[name] = {
      status: "pending",
      attempts: 0,
      elements: 0,
      error: "",
      http_status: null,
    };

    for (let attempt = 1; attempt <= OVERPASS_RETRY_DELAYS_MS.length + 1; attempt += 1) {
      const timeoutMs = remainingBudgetMs();
      if (timeoutMs <= 0) {
        queryStatuses[name] = {
          ...queryStatuses[name],
          status: attempt === 1 ? "skipped" : "failed",
          attempts: attempt - 1,
          error: "total_budget_exhausted",
          elapsed_ms: Date.now() - queryStarted,
        };
        console.log("[geometry-build] stage:fetchCourseFeatureElements query_skipped", {
          query: name,
          osm_id: osmId(course),
          reason: "total_budget_exhausted",
        });
        return [];
      }

      queryStatuses[name].attempts = attempt;
      console.log("[geometry-build] stage:fetchCourseFeatureElements query_start", {
        query: name,
        osm_id: osmId(course),
        attempt,
        remaining_budget_ms: timeoutMs,
      });

      try {
        const data = await overpass(query, `${stage}:${name}`, timeoutMs);
        const queryElements = data.elements || [];
        elements.push(...queryElements);
        queryStatuses[name] = {
          ...queryStatuses[name],
          status: "success",
          attempts: attempt,
          elements: queryElements.length,
          error: "",
          http_status: null,
          elapsed_ms: Date.now() - queryStarted,
        };
        console.log("[geometry-build] stage:fetchCourseFeatureElements query_success", {
          query: name,
          osm_id: osmId(course),
          attempt,
          elapsed_ms: Date.now() - queryStarted,
          elements: queryElements.length,
        });
        return queryElements;
      } catch (error) {
        const retryDelayMs = retryDelayForOverpassError(error, attempt);
        const canRetry = retryDelayMs > 0 && remainingBudgetMs() > retryDelayMs;
        console.log("[geometry-build] stage:fetchCourseFeatureElements query_failed", {
          query: name,
          osm_id: osmId(course),
          attempt,
          retrying: canRetry,
          retry_delay_ms: canRetry ? retryDelayMs : 0,
          elapsed_ms: Date.now() - queryStarted,
          error: readableError(error),
        });

        if (canRetry) {
          await delay(retryDelayMs);
          continue;
        }

        queryStatuses[name] = {
          ...queryStatuses[name],
          status: "failed",
          attempts: attempt,
          elements: 0,
          error: readableError(error),
          http_status: error.status || null,
          elapsed_ms: Date.now() - queryStarted,
        };
        return [];
      }
    }

    queryStatuses[name] = {
      ...queryStatuses[name],
      status: "failed",
      error: "retry_attempts_exhausted",
      elapsed_ms: Date.now() - queryStarted,
    };
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

  const holeElements =
    (await runFeatureQuery(
      "golf_holes_1_18",
      `
        [out:json][timeout:90];
        way["golf"="hole"]["ref"~"^([1-9]|1[0-8])$"](around:${featureRadiusMeters},${center.lat},${center.lng});
        out geom;
      `,
    )) || [];
  const foundHoleRefs = new Set(validHoleRefsFromElements(holeElements).filter((ref) => ref >= 1 && ref <= 18));
  console.log("[geometry-build] stage:fetchCourseFeatureElements golf_holes_refs", {
    osm_id: osmId(course),
    hole_refs_found: [...foundHoleRefs].sort((a, b) => a - b),
  });

  await runFeatureQuery(
    "golf_extra_features",
    `
      [out:json][timeout:90];
      nwr["golf"~"^(tee|bunker|fairway|water_hazard|lateral_water_hazard)$"](around:${featureRadiusMeters},${center.lat},${center.lng});
      out body geom;
    `,
  );

  console.log("[geometry-build] stage:fetchCourseFeatureElements success", {
    osm_id: osmId(course),
    elapsed_ms: Date.now() - started,
    elements: elements.length,
    query_statuses: queryStatuses,
  });

  return { elements, queryStatuses };
}

function retryDelayForOverpassError(error, attempt) {
  if (!OVERPASS_RETRYABLE_STATUSES.has(error.status)) return 0;
  return OVERPASS_RETRY_DELAYS_MS[attempt - 1] || 0;
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

  if (geometryQueryFailed(geometry, "golf_extra_features")) {
    notes.push(
      "Tees, bunkers, water, fairways, and hazards may be incomplete because the golf_extra_features Overpass query failed.",
    );
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
