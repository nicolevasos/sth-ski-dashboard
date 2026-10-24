(() => {
  'use strict';

  const CONFIG = Object.freeze({
    primaryBufferKm: 14,
    extendedBufferKm: 28,
    maxResults: 8,
    requestTimeoutMs: 18000,
    cacheTtlMs: 24 * 60 * 60 * 1000,
    cachePrefix: 'ski-dashboard-service-partners-v1:',
    endpoints: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter'
    ]
  });

  function validateAoi(aoi) {
    const minLat = Number(aoi?.minLat);
    const minLon = Number(aoi?.minLon);
    const maxLat = Number(aoi?.maxLat);
    const maxLon = Number(aoi?.maxLon);
    if (![minLat, minLon, maxLat, maxLon].every(Number.isFinite)) return null;
    if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) return null;
    if (minLat > maxLat || minLon > maxLon) return null;
    const centroidLat = Number.isFinite(Number(aoi.centroidLat)) ? Number(aoi.centroidLat) : (minLat + maxLat) / 2;
    const centroidLon = Number.isFinite(Number(aoi.centroidLon)) ? Number(aoi.centroidLon) : (minLon + maxLon) / 2;
    return {minLat, minLon, maxLat, maxLon, centroidLat, centroidLon};
  }

  function expandAoi(aoi, bufferKm) {
    const valid = validateAoi(aoi);
    if (!valid) return null;
    const latitudeBuffer = bufferKm / 110.574;
    const cosLatitude = Math.max(0.15, Math.cos(valid.centroidLat * Math.PI / 180));
    const longitudeBuffer = bufferKm / (111.320 * cosLatitude);
    return {
      south: clamp(valid.minLat - latitudeBuffer, -90, 90),
      west: clamp(valid.minLon - longitudeBuffer, -180, 180),
      north: clamp(valid.maxLat + latitudeBuffer, -90, 90),
      east: clamp(valid.maxLon + longitudeBuffer, -180, 180),
      bufferKm,
      centroidLat: valid.centroidLat,
      centroidLon: valid.centroidLon
    };
  }

  function buildOverpassQuery(searchBounds) {
    const bbox = [searchBounds.south, searchBounds.west, searchBounds.north, searchBounds.east]
      .map(value => Number(value).toFixed(6)).join(',');
    return `[out:json][timeout:20];
(
  nwr["service:ski"="yes"](${bbox});
  nwr["ski_service"="yes"](${bbox});
  nwr["ski_rental"="yes"](${bbox});
  nwr["craft"~"ski|ski_service|sports_equipment",i](${bbox});
  nwr["rental"~"ski|winter_sports",i](${bbox});
  nwr["repair"~"ski|sports_equipment",i](${bbox});
  nwr["shop"~"^(ski|sports|outdoor)$",i](${bbox});
  nwr["name"~"ski|snow|winter|sport",i]["shop"](${bbox});
);
out center tags;`;
  }

  async function lookup(aoi, routePoints = [], options = {}) {
    const validAoi = validateAoi(aoi);
    if (!validAoi) throw new Error('The uploaded data does not contain a valid spatial extent.');

    const attempts = [
      Number(options.primaryBufferKm) || CONFIG.primaryBufferKm,
      Number(options.extendedBufferKm) || CONFIG.extendedBufferKm
    ];
    let lastError = null;

    for (const bufferKm of attempts) {
      const searchBounds = expandAoi(validAoi, bufferKm);
      const cached = readCache(searchBounds);
      let rawElements;
      let endpoint = null;
      let fromCache = false;

      if (cached) {
        rawElements = cached.elements;
        endpoint = cached.endpoint || 'OpenStreetMap cache';
        fromCache = true;
      } else {
        try {
          const response = await fetchOverpass(searchBounds, options);
          rawElements = response.elements;
          endpoint = response.endpoint;
          writeCache(searchBounds, rawElements, endpoint);
        } catch (error) {
          lastError = error;
          continue;
        }
      }

      const partners = normalizePartners(rawElements, routePoints, validAoi)
        .slice(0, Number(options.maxResults) || CONFIG.maxResults);

      if (partners.length || bufferKm === attempts[attempts.length - 1]) {
        return {
          partners,
          aoi: validAoi,
          searchBounds,
          bufferKm,
          endpoint,
          fromCache,
          retrievedAt: new Date().toISOString(),
          sourceLabel: 'OpenStreetMap via Overpass API'
        };
      }
    }

    throw lastError || new Error('No service-partner lookup could be completed.');
  }

  async function fetchOverpass(searchBounds, options = {}) {
    const query = buildOverpassQuery(searchBounds);
    const endpoints = Array.isArray(options.endpoints) && options.endpoints.length
      ? options.endpoints
      : CONFIG.endpoints;
    let lastError = null;

    for (const endpoint of endpoints) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(options.requestTimeoutMs) || CONFIG.requestTimeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'},
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Service lookup failed with HTTP ${response.status}.`);
        const payload = await response.json();
        if (!Array.isArray(payload?.elements)) throw new Error('The service lookup returned an invalid response.');
        return {elements: payload.elements, endpoint};
      } catch (error) {
        lastError = error?.name === 'AbortError'
          ? new Error('The service-partner lookup timed out.')
          : error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new Error('All service-partner lookup endpoints were unavailable.');
  }

  function normalizePartners(elements, routePoints, aoi) {
    const route = compactRoutePoints(routePoints, aoi);
    const candidates = [];

    for (const element of elements || []) {
      const tags = element?.tags || {};
      const latitude = Number(element?.lat ?? element?.center?.lat);
      const longitude = Number(element?.lon ?? element?.center?.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

      const name = String(tags.name || tags.brand || tags.operator || '').trim();
      const capabilities = describeCapabilities(tags);
      const relevance = relevanceScore(tags, name, capabilities);
      if (relevance < 20) continue;

      const distanceKm = minimumDistanceKm(latitude, longitude, route);
      const address = formatAddress(tags);
      const phone = firstNonEmpty(tags.phone, tags['contact:phone'], tags.mobile, tags['contact:mobile']);
      const website = sanitizeUrl(firstNonEmpty(tags.website, tags['contact:website'], tags.url));
      const email = firstNonEmpty(tags.email, tags['contact:email']);
      const openingHours = firstNonEmpty(tags.opening_hours);
      const displayName = name || genericPartnerName(tags, capabilities);
      const confidence = relevance >= 85 ? 'confirmed' : relevance >= 55 ? 'likely' : 'possible';

      candidates.push({
        id: `${element.type || 'element'}-${element.id}`,
        osmType: element.type || 'node',
        osmId: element.id,
        name: displayName,
        latitude,
        longitude,
        distanceKm,
        capabilities,
        address,
        phone,
        website,
        email,
        openingHours,
        confidence,
        relevance,
        osmUrl: `https://www.openstreetmap.org/${element.type || 'node'}/${element.id}`,
        tags
      });
    }

    const deduplicated = deduplicatePartners(candidates);
    const confidenceOrder = {confirmed: 0, likely: 1, possible: 2};
    return deduplicated.sort((a, b) => {
      const confidenceDifference = (confidenceOrder[a.confidence] ?? 3) - (confidenceOrder[b.confidence] ?? 3);
      if (confidenceDifference) return confidenceDifference;
      const distanceDifference = finiteOrInfinity(a.distanceKm) - finiteOrInfinity(b.distanceKm);
      if (Math.abs(distanceDifference) > 0.15) return distanceDifference;
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return a.name.localeCompare(b.name);
    });
  }

  function describeCapabilities(tags) {
    const capabilities = [];
    const text = Object.values(tags || {}).join(' ').toLowerCase();
    const shop = String(tags.shop || '').toLowerCase();
    const rental = String(tags.rental || tags.ski_rental || '').toLowerCase();

    if (isYes(tags['service:ski']) || isYes(tags.ski_service) || /ski[_ ]?service|ski tuning|base grind|edge sharpen/.test(text)) {
      capabilities.push('Ski service / tuning');
    }
    if (/ski|winter_sports/.test(rental) || isYes(tags.ski_rental)) capabilities.push('Ski rental');
    if (/wax|wachsen/.test(text)) capabilities.push('Waxing');
    if (/repair|reparatur/.test(text)) capabilities.push('Repairs');
    if (shop === 'ski') capabilities.push('Ski shop');
    else if (shop === 'sports') capabilities.push('Sports shop');
    else if (shop === 'outdoor') capabilities.push('Outdoor shop');
    if (String(tags.sport || '').toLowerCase() === 'skiing') capabilities.push('Skiing specialist');

    return [...new Set(capabilities)].slice(0, 4);
  }

  function relevanceScore(tags, name, capabilities) {
    const lowerName = String(name || '').toLowerCase();
    const shop = String(tags.shop || '').toLowerCase();
    const text = Object.values(tags || {}).join(' ').toLowerCase();
    let score = 0;

    if (isYes(tags['service:ski']) || isYes(tags.ski_service)) score += 100;
    if (/ski[_ ]?service|ski tuning|base grind|edge sharpen/.test(text)) score += 75;
    if (shop === 'ski') score += 70;
    if (/ski|winter_sports/.test(String(tags.rental || tags.ski_rental || '').toLowerCase())) score += 55;
    if (/ski|snow|winter/.test(lowerName)) score += 35;
    if (shop === 'sports') score += 32;
    if (shop === 'outdoor') score += 24;
    if (/wax|repair|tuning|service/.test(text)) score += 18;
    if (capabilities.length >= 2) score += 10;
    if (firstNonEmpty(tags.phone, tags['contact:phone'], tags.website, tags['contact:website'])) score += 4;
    return score;
  }

  function deduplicatePartners(partners) {
    const seen = new Map();
    for (const partner of partners) {
      const normalizedName = normalizeText(partner.name);
      const locationKey = `${partner.latitude.toFixed(4)},${partner.longitude.toFixed(4)}`;
      const contactKey = normalizeText(partner.website || partner.phone || '');
      const key = contactKey || `${normalizedName}|${locationKey}`;
      const existing = seen.get(key);
      if (!existing || partner.relevance > existing.relevance) seen.set(key, partner);
    }
    return [...seen.values()];
  }

  function compactRoutePoints(routePoints, aoi) {
    const valid = (routePoints || [])
      .map(point => ({lat: Number(point?.lat), lon: Number(point?.lon)}))
      .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    if (!valid.length) return [{lat: aoi.centroidLat, lon: aoi.centroidLon}];
    if (valid.length <= 500) return valid;
    const step = Math.ceil(valid.length / 500);
    const sampled = valid.filter((_, index) => index % step === 0);
    if (sampled[sampled.length - 1] !== valid[valid.length - 1]) sampled.push(valid[valid.length - 1]);
    return sampled;
  }

  function minimumDistanceKm(latitude, longitude, routePoints) {
    let minimum = Infinity;
    for (const point of routePoints) {
      const distance = haversineKm(latitude, longitude, point.lat, point.lon);
      if (distance < minimum) minimum = distance;
    }
    return Number.isFinite(minimum) ? minimum : null;
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const earthRadiusKm = 6371.0088;
    const toRadians = value => value * Math.PI / 180;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatAddress(tags) {
    const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
    const locality = [tags['addr:postcode'], tags['addr:city'] || tags['addr:town'] || tags['addr:village']]
      .filter(Boolean).join(' ');
    return [street, locality].filter(Boolean).join(', ');
  }

  function genericPartnerName(tags, capabilities) {
    if (tags.operator) return String(tags.operator);
    if (capabilities[0]) return capabilities[0];
    if (tags.shop) return `${String(tags.shop).replace(/_/g, ' ')} shop`;
    return 'Service partner';
  }

  function cacheKey(searchBounds) {
    return `${CONFIG.cachePrefix}${[
      searchBounds.south, searchBounds.west, searchBounds.north, searchBounds.east
    ].map(value => Number(value).toFixed(3)).join(':')}`;
  }

  function readCache(searchBounds) {
    try {
      const record = JSON.parse(localStorage.getItem(cacheKey(searchBounds)) || 'null');
      if (!record || !Array.isArray(record.elements)) return null;
      if (Date.now() - Number(record.savedAt || 0) > CONFIG.cacheTtlMs) return null;
      return record;
    } catch (_) {
      return null;
    }
  }

  function writeCache(searchBounds, elements, endpoint) {
    try {
      localStorage.setItem(cacheKey(searchBounds), JSON.stringify({
        savedAt: Date.now(),
        endpoint,
        elements
      }));
    } catch (_) {
      // Browsers may reject storage in private mode; lookup should still work.
    }
  }

  function firstNonEmpty(...values) {
    return values.find(value => value !== null && value !== undefined && String(value).trim() !== '') || '';
  }

  function sanitizeUrl(value) {
    if (!value) return '';
    try {
      const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
      const url = new URL(candidate);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function isYes(value) {
    return ['yes', 'true', '1', 'service'].includes(String(value || '').toLowerCase());
  }

  function normalizeText(value) {
    return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function finiteOrInfinity(value) {
    return Number.isFinite(Number(value)) ? Number(value) : Infinity;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  window.ServicePartnerFinder = {
    lookup,
    validateAoi,
    expandAoi,
    buildOverpassQuery,
    normalizePartners,
    describeCapabilities,
    relevanceScore,
    haversineKm,
    CONFIG
  };
})();
