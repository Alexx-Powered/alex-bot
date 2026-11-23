import { readFileSync } from 'node:fs';
import {searchOutdoorPlaces} from './outdoor-places.mjs';

export const CITIES = Object.freeze({
  beijing: Object.freeze({ id: 'beijing', name: '北京', latitude: 39.9042, longitude: 116.4074 }),
  tianjin: Object.freeze({ id: 'tianjin', name: '天津', latitude: 39.0842, longitude: 117.2009 }),
  guangzhou: Object.freeze({ id: 'guangzhou', name: '广州', latitude: 23.1291, longitude: 113.2644 }),
});
const NAME = /^[\p{L}\p{M}\p{N} ·（）(),，.'’\-]+$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const MAX_BODY_BYTES = 512 * 1024;
const MAX_CACHE = 512;
const MAX_CONCURRENT = 2;
const FEATURES = new Set(['PPLC', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPL', 'PPLX', 'ADM2', 'ADM3', 'ADM4']);

export class LocationError extends Error {
  constructor(code, suggestions) {
    super(code); this.name = 'LocationError'; this.code = code;
    if (suggestions) this.suggestions = [...suggestions];
  }
}
const invalid = () => new LocationError('LOCATION_INPUT_INVALID');
function label(value, max = 100) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max && NAME.test(value);
}

/** Project trusted coordinates and harmless labels; discard extra payload fields. */
export function validatePlace(value) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      typeof value.id !== 'string' || !ID.test(value.id) || !label(value.name) ||
      typeof value.latitude !== 'number' || !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90 ||
      typeof value.longitude !== 'number' || !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180) throw invalid();
  const result = { id: value.id, name: value.name, latitude: value.latitude, longitude: value.longitude };
  for (const key of ['admin1', 'admin2', 'country']) {
    if (value[key] !== undefined) {
      if (!label(value[key], 80)) throw invalid();
      result[key] = value[key];
    }
  }
  if (value.countryCode !== undefined) {
    if (typeof value.countryCode !== 'string' || !/^[A-Z]{2}$/.test(value.countryCode)) throw invalid();
    result.countryCode = value.countryCode;
  }
  return result;
}

const document = JSON.parse(readFileSync(new URL('../data/weather-locations.json', import.meta.url), 'utf8'));
if (!Array.isArray(document.places)) throw new Error('LOCATION_CATALOG_INVALID');
const catalog = document.places.map((row) => ({ ...validatePlace(row), aliases: [...(row.aliases || [])] }));
export const LOCATION_METADATA = Object.freeze(structuredClone(document.metadata));
export function getLocationCatalog() { return catalog.map((place) => ({ ...validatePlace(place) })); }

const compact = (value) => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[\s·,，]/gu, '').replaceAll('’', "'");
const byId = new Map();
const aliases = new Map();
function addAlias(value, place) {
  if (!label(value)) return;
  const key = compact(value);
  if (!aliases.has(key)) aliases.set(key, new Map());
  aliases.get(key).set(place.id, place);
}
for (const row of catalog) {
  if (byId.has(row.id)) throw new Error('LOCATION_CATALOG_INVALID');
  const place = Object.freeze(validatePlace(row)); byId.set(place.id, place);
  addAlias(place.name, place);
  for (const alias of row.aliases) addAlias(alias, place);
}
const outdoorCatalog=JSON.parse(readFileSync(new URL('../data/outdoor-locations.json', import.meta.url),'utf8'));
for(const row of outdoorCatalog.places){const place=Object.freeze(validatePlace(row));byId.set(place.id,place);for(const name of [place.name,...row.aliases])addAlias(name,place);}
for (const place of Object.values(CITIES)) {
  byId.set(place.id, place);
  for (const key of [place.id, place.name, `${place.name}市`]) aliases.set(compact(key), new Map([[place.id, place]]));
}

function choose(places, query) {
  if (!places.length) throw new LocationError('LOCATION_NOT_FOUND');
  if (places.length === 1) return { ...places[0] };
  if (query) {
    const key = compact(query);
    const score = place => {
      const name = compact(place.name.split('·').at(-1));
      if (name === key) return 3;
      if (compact(place.name).endsWith(key)) return 2;
      return name.includes(key) ? 1 : 0;
    };
    // Keep provider relevance order for equal textual matches.
    return {...places.reduce((best, place) => score(place) > score(best) ? place : best)};
  }
  const suggestions = [...places].sort((a, b) => a.name.localeCompare(b.name, 'zh') || a.id.localeCompare(b.id)).slice(0, 8)
    .map((place) => { const entry = `${place.name}（${place.id}）`; return entry.length <= 60 ? entry : place.id; });
  throw new LocationError('LOCATION_AMBIGUOUS', suggestions);
}

export class LocationService {
  #fetch; #now; #cache = new Map(); #inflight = new Map(); #active = 0; #waiting = [];
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, outdoorLookup = searchOutdoorPlaces, preferBest = false } = {}) {
    this.preferBest = preferBest;
    this.outdoorLookup=outdoorLookup;
    if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw invalid();
    this.#fetch = fetchImpl; this.#now = now;
  }
  async resolve(input, {preferBest = this.preferBest} = {}) {
    if (typeof input !== 'string') throw invalid();
    const query = input.normalize('NFKC').trim();
    if (!query || query.length > 60 || !NAME.test(query)) throw invalid();
    const selected = /\((landmark-[A-Za-z0-9-]+|amap-[A-Za-z0-9]+|osm-[nwr]-\d+|geonames-\d+|qweather-[A-Za-z0-9]+|beijing|tianjin|guangzhou)\)$/.exec(query);
    const id = selected?.[1] ?? query;
    if (byId.has(id)) return { ...byId.get(id) };
    // A suggested dynamic result may be selected by its stable ID from cache.
    if (/^(?:geonames-\d+|osm-[nwr]-\d+|amap-[A-Za-z0-9]+)$/.test(id)) {
      for (const entry of this.#cache.values()) {
        const found = entry.places.find((p) => p.id === id);
        if (entry.expiresAt > this.#now() && found) return { ...found };
      }
      throw new LocationError('LOCATION_NOT_FOUND');
    }
    const key = compact(query);
    const rank = preferBest ? query : undefined;
    if (aliases.has(key)) return choose([...aliases.get(key).values()], rank);
    // The published CSV often omits the conventional suffix (e.g. 海淀).
    // Prefer an exact alias; only then retry the same qualified name without
    // one trailing suffix. Do not select a candidate from an ambiguous set.
    const withoutSuffix = key.replace(/[市区县旗]$/u, '');
    if (withoutSuffix !== key && aliases.has(withoutSuffix)) return choose([...aliases.get(withoutSuffix).values()], rank);
    if (/^qweather-[A-Za-z0-9]+$/.test(id)) throw new LocationError('LOCATION_NOT_FOUND');
    const time = this.#now();
    if (!Number.isSafeInteger(time) || time < 0) throw invalid();
    const cacheKey = (preferBest ? 'best:' : 'strict:') + key;
    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expiresAt > time) return choose(cached.places, rank);
    if (!this.#inflight.has(cacheKey)) {
      const pending = this.#lookup(query, preferBest).then((places) => {
        if (this.#cache.size >= MAX_CACHE) this.#cache.delete(this.#cache.keys().next().value);
        this.#cache.set(cacheKey, { places, expiresAt: this.#now() + (places.length ? 24 * 3600_000 : 10 * 60_000) });
        return places;
      }).finally(() => this.#inflight.delete(cacheKey));
      this.#inflight.set(cacheKey, pending);
    }
    return choose(await this.#inflight.get(cacheKey), rank);
  }
  async #lookup(query, preferBest) {
    const outdoor=async()=>{
      const rows=await this.outdoorLookup(query,{expanded:preferBest});
      if(!Array.isArray(rows)||rows.length>8)throw new LocationError('LOCATION_SOURCE_UNAVAILABLE');
      return rows.map(row=>{const p=validatePlace(row);if(!/^osm-[nwr]-\d+$/.test(p.id)&&!(preferBest&&/^amap-[A-Za-z0-9]+$/.test(p.id)))throw invalid();return p;});
    };
    // POI-shaped queries must not silently turn into a nearby town or road.
    if(preferBest){
      const poi=/村|峰|山|岭|峡|沟|湖|岛|景区|公园|古道|步道|寺|车站|机场|大学|博物馆|trail|peak|mount/i.test(query);
      const gazetteer=()=>this.#legacyLookup(query,poi);
      let unavailable=false;
      for(const lookup of poi?[outdoor,gazetteer]:[gazetteer,outdoor]){
        try { const places=await lookup(); if(places.length)return places; }
        catch { unavailable=true; }
      }
      if(unavailable)throw new LocationError('LOCATION_SOURCE_UNAVAILABLE');
      return [];
    }
    if(/村|峰|山|岭|峡|沟|湖|岛|景区|公园|古道|步道|徒步|穿越|径|徑|线$|trail|peak|mount/i.test(query))return outdoor();
    const places=await this.#legacyLookup(query);
    return places.length?places:outdoor();
  }
  async #legacyLookup(query, poi = false) {
    if (this.#active >= MAX_CONCURRENT) await new Promise((resolve) => this.#waiting.push(resolve));
    this.#active++;
    try {
      const url = new URL(GEOCODING_URL);
      url.search = new URLSearchParams({ name: query.replaceAll('，', ','), count: '100', language: 'zh', format: 'json' }).toString();
      const response = await this.#fetch(url.href, { method: 'GET', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok || !/\bapplication\/json\b/i.test(response.headers.get('content-type') || '') || !response.body ||
          Number(response.headers.get('content-length')) > MAX_BODY_BYTES) throw new Error('SOURCE');
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('SOURCE'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.error ||
          (data.results !== undefined && (!Array.isArray(data.results) || data.results.length > 100))) throw new Error('SOURCE');
      const candidates = new Map();
      for (const item of data.results || []) {
        if (!item || typeof item !== 'object') throw new Error('SOURCE');
        if (poi) {
          if (!label(item.name,80) || !compact(query).endsWith(compact(item.name))) continue;
          if (/[峰岭山]$/u.test(query) && !['MT','MTS','PK','PKS','RDGE','PASS','HLL','HLLS','SPUR'].includes(item.feature_code)) continue;
        } else if (!FEATURES.has(item.feature_code)) continue;
        if (!Number.isSafeInteger(item.id) || item.id <= 0 || !label(item.name, 80)) throw new Error('SOURCE');
        const parts = [item.country, item.admin1, item.admin2, item.name].filter((value) => value !== undefined && value !== '');
        if (parts.some((value) => !label(value, 80))) throw new Error('SOURCE');
        const name = [...new Set(parts)].join('·');
        const place = validatePlace({ id: `geonames-${item.id}`, name, latitude: item.latitude, longitude: item.longitude,
          ...(item.admin1 ? { admin1: item.admin1 } : {}), ...(item.admin2 ? { admin2: item.admin2 } : {}),
          ...(item.country ? { country: item.country } : {}), ...(item.country_code ? { countryCode: item.country_code } : {}),
        });
        candidates.set(place.id, place);
      }
      return [...candidates.values()];
    } catch(error) { throw new LocationError(['TimeoutError','AbortError'].includes(error?.name)?'LOCATION_SOURCE_TIMEOUT':'LOCATION_SOURCE_UNAVAILABLE'); }
    finally { this.#active--; this.#waiting.shift()?.(); }
  }
}
