import { logger } from '../utils/logger.js';

/**
 * Map GHL date-stamped city tags to HubSpot eventtag city names.
 *
 * GHL tags events as `YYYYMMDD_CITYCODE` (e.g. `20260330_aus`).
 * Contacts accumulate one tag per event attended, plus variants with
 * `_attended`, `_non-attendee` etc. suffixes — all share the same city code.
 *
 * Returns the deduplicated list of city names for HubSpot's `eventtag`
 * multi-select property (semicolon-separated).
 */

const EVENT_TAG_RE = /^\d{8}_([a-z]{2,5})/i;

/** Airport/city code → HubSpot eventtag display value */
const CITY_CODE_MAP = {
  aus: 'Austin',
  cae: 'Columbia',
  ccr: 'Concord',
  cle: 'Cleveland',
  dtw: 'Detroit',
  fre: 'Fresno',
  hnl: 'Honolulu',
  ind: 'Indianapolis',
  jfk: 'New York',
  lax: 'Los Angeles',
  lbb: 'Lubbock',
  mdt: 'Harrisburg',
  mnh: 'Manhasset',
  ord: 'Chicago',
  orf: 'Norfolk',
  phl: 'Philadelphia',
  phx: 'Phoenix',
  pit: 'Pittsburgh',
  san: 'San Diego',
  sat: 'San Antonio',
  sba: 'Santa Barbara',
  spo: 'Spokane',
  wbs: 'West Palm Beach',
  tpa: 'Tampa',
  mia: 'Miami',
  rdu: 'Raleigh',
  atl: 'Atlanta',
  bhm: 'Birmingham',
  boi: 'Boise',
  knx: 'Knoxville',
  roc: 'Rochester',
  mob: 'Mobile',
  dfw: 'Dallas',
  ftw: 'Fort Worth',
  dca: 'Washington DC',
  oma: 'Omaha',
  mem: 'Memphis',
  bos: 'Boston',
  ods: 'Odessa',
  ewr: 'Newark',
  sea: 'Seattle',
  anc: 'Anchorage',
  ftm: 'Fort Myers',
  bwi: 'Baltimore',
  mco: 'Orlando',
  jax: 'Jacksonville',
  ftl: 'Fort Lauderdale',
  cmh: 'Columbus',
  ric: 'Richmond',
  clt: 'Charlotte',
  mci: 'Kansas City',
  ken: 'Kennewick',
  gsb: 'Greensboro',
  bmh: 'Birmingham',
  har: 'Hartford',
  gsp: 'Greenville',
  iah: 'Houston',
  okc: 'Oklahoma City',
  lit: 'Little Rock',
  las: 'Las Vegas',
  bna: 'Nashville',
  den: 'Denver',
  tus: 'Tucson',
  lou: 'Louisville',
  mke: 'Milwaukee',
  mlw: 'Milwaukee',
  ont: 'Ontario',
  sfo: 'San Francisco',
  bur: 'Burbank',
  pdx: 'Portland OR',
  pwm: 'Portland ME',
  elp: 'El Paso',
  smf: 'Sacramento',
  alb: 'Albany',
  stl: 'St. Louis',
  shv: 'Shreveport',
  grb: 'Green Bay',
  dsm: 'Des Moines',
  mca: 'Mcallen',
};

/**
 * Resolve GHL event tags to HubSpot eventtag values.
 *
 * @param {string[]} tags - Raw GHL contact tags array
 * @returns {{ eventtag: string|null, unknownCodes: string[] }}
 *   eventtag — semicolon-separated city names ready for HubSpot multi-select (null if none)
 *   unknownCodes — codes with no mapping (logged for discovery)
 */
export function resolveEventTags(tags = []) {
  const seenCodes = new Set();
  const cities = [];
  const unknownCodes = [];

  for (const tag of tags) {
    const match = tag.match(EVENT_TAG_RE);
    if (!match) continue;

    const code = match[1].toLowerCase();
    if (seenCodes.has(code)) continue;
    seenCodes.add(code);

    if (CITY_CODE_MAP[code]) {
      cities.push(CITY_CODE_MAP[code]);
    } else {
      unknownCodes.push(code);
    }
  }

  if (unknownCodes.length > 0) {
    logger.warn(`geoResolver: unknown city codes [${unknownCodes.join(', ')}] — add to CITY_CODE_MAP`);
  }

  return {
    eventtag: cities.length > 0 ? cities.join(';') : null,
    unknownCodes,
  };
}
