'use strict';

const fs = require('node:fs/promises');
const { DatabaseSync } = require('node:sqlite');

const DEFAULTS = Object.freeze({
  aircraftPath: '/run/readsb/aircraft.json',
  statsPath: '/run/readsb/stats.json',
  databasePath: '/var/lib/readsb-live-history/readsb-live-history.sqlite3',
  pollSeconds: 10,
  maxSeenSeconds: 30,
  encounterCloseSeconds: 60,
  periodicSnapshotSeconds: 60,
  statsSnapshotSeconds: 60,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS readsb_encounters (
  id INTEGER PRIMARY KEY,
  hex TEXT NOT NULL,
  first_seen_at REAL NOT NULL,
  last_seen_at REAL NOT NULL,
  closed_at REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  total_message_delta INTEGER NOT NULL DEFAULT 0,
  first_position_at REAL,
  last_position_at REAL,
  positioned_poll_count INTEGER NOT NULL DEFAULT 0,
  positionless_poll_count INTEGER NOT NULL DEFAULT 0,
  first_callsign TEXT,
  last_callsign TEXT,
  military INTEGER,
  military_provenance TEXT NOT NULL DEFAULT 'unknown',
  min_rssi REAL,
  max_rssi REAL,
  rssi_sum REAL NOT NULL DEFAULT 0,
  rssi_count INTEGER NOT NULL DEFAULT 0,
  close_reason TEXT,
  last_messages INTEGER,
  last_sample_at REAL,
  last_state_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS readsb_encounters_one_open_hex
  ON readsb_encounters(hex) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS readsb_encounters_hex_time
  ON readsb_encounters(hex, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS readsb_encounters_open_last_seen
  ON readsb_encounters(last_seen_at) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS readsb_samples (
  id INTEGER PRIMARY KEY,
  sampled_at REAL NOT NULL,
  readsb_now REAL,
  encounter_id INTEGER NOT NULL REFERENCES readsb_encounters(id),
  hex TEXT NOT NULL,
  callsign TEXT,
  squawk TEXT,
  category TEXT,
  readsb_type TEXT,
  addr_type TEXT,
  dbflags INTEGER,
  military INTEGER,
  military_provenance TEXT NOT NULL,
  position_state TEXT NOT NULL CHECK(position_state IN ('positioned','positionless')),
  messages INTEGER,
  message_delta INTEGER NOT NULL,
  rssi REAL,
  seen REAL,
  seen_pos REAL,
  lat REAL,
  lon REAL,
  alt_baro,
  alt_geom REAL,
  gs REAL,
  track REAL,
  baro_rate REAL,
  geom_rate REAL,
  emergency TEXT,
  alert INTEGER,
  spi INTEGER,
  version INTEGER,
  nic INTEGER,
  nic_baro INTEGER,
  nac_p INTEGER,
  nac_v INTEGER,
  sil INTEGER,
  sil_type TEXT,
  gva INTEGER,
  sda INTEGER,
  rc REAL,
  true_heading REAL,
  mag_heading REAL,
  ias REAL,
  tas REAL,
  mach REAL,
  roll REAL,
  track_rate REAL,
  calc_track REAL,
  nav_qnh REAL,
  nav_altitude_mcp REAL,
  nav_altitude_fms REAL,
  nav_heading REAL,
  nav_modes_json TEXT,
  oat REAL,
  tat REAL,
  wind_direction REAL,
  wind_speed REAL,
  source_fields_json TEXT
);
CREATE INDEX IF NOT EXISTS readsb_samples_encounter_time
  ON readsb_samples(encounter_id, sampled_at);
CREATE INDEX IF NOT EXISTS readsb_samples_hex_time
  ON readsb_samples(hex, sampled_at DESC);

CREATE TABLE IF NOT EXISTS readsb_receiver_stats (
  id INTEGER PRIMARY KEY,
  sampled_at REAL NOT NULL,
  readsb_now REAL NOT NULL UNIQUE,
  receiver_uptime_seconds REAL,
  gain_db REAL,
  estimated_ppm REAL,
  aircraft_with_pos INTEGER,
  aircraft_without_pos INTEGER,
  aircraft_count_by_type_json TEXT,
  window_start REAL,
  window_end REAL,
  messages INTEGER,
  messages_valid INTEGER,
  position_count_total INTEGER,
  position_count_by_type_json TEXT,
  max_distance_m REAL,
  tracks_all INTEGER,
  tracks_single_message INTEGER,
  local_accepted_0 INTEGER,
  local_accepted_1 INTEGER,
  local_modeac INTEGER,
  local_modes INTEGER,
  local_bad INTEGER,
  local_unknown_icao INTEGER,
  local_signal_dbfs REAL,
  local_noise_dbfs REAL,
  local_peak_signal_dbfs REAL,
  local_strong_signals INTEGER,
  local_samples_dropped INTEGER,
  local_samples_lost INTEGER,
  local_samples_processed INTEGER,
  remote_accepted_0 INTEGER,
  remote_accepted_1 INTEGER,
  remote_modeac INTEGER,
  remote_modes INTEGER,
  remote_bad INTEGER,
  remote_bytes_in INTEGER,
  cpr_airborne INTEGER,
  cpr_surface INTEGER,
  cpr_global_ok INTEGER,
  cpr_global_bad INTEGER,
  cpr_global_range INTEGER,
  cpr_global_speed INTEGER,
  cpr_local_ok INTEGER,
  cpr_local_range INTEGER,
  cpr_local_speed INTEGER,
  total_messages INTEGER,
  total_messages_valid INTEGER,
  total_position_count INTEGER,
  total_local_samples_dropped INTEGER,
  total_local_samples_lost INTEGER,
  cpu_json TEXT
);
CREATE INDEX IF NOT EXISTS readsb_receiver_stats_sampled_at
  ON readsb_receiver_stats(sampled_at DESC);

CREATE TABLE IF NOT EXISTS readsb_ingestion_state (
  source TEXT PRIMARY KEY,
  last_readsb_now REAL NOT NULL,
  last_observed_at REAL NOT NULL
);
`;

const SAMPLE_MIGRATIONS = Object.freeze({
  alert: 'INTEGER', spi: 'INTEGER', version: 'INTEGER', nic: 'INTEGER', nic_baro: 'INTEGER', nac_p: 'INTEGER', nac_v: 'INTEGER',
  sil: 'INTEGER', sil_type: 'TEXT', gva: 'INTEGER', sda: 'INTEGER', rc: 'REAL', true_heading: 'REAL', mag_heading: 'REAL',
  ias: 'REAL', tas: 'REAL', mach: 'REAL', roll: 'REAL', track_rate: 'REAL', calc_track: 'REAL', nav_qnh: 'REAL',
  nav_altitude_mcp: 'REAL', nav_altitude_fms: 'REAL', nav_heading: 'REAL', nav_modes_json: 'TEXT', oat: 'REAL', tat: 'REAL',
  wind_direction: 'REAL', wind_speed: 'REAL',
});

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result || null;
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function anyInteger(value) { return Number.isSafeInteger(value) ? value : null; }
function json(value) { return value && typeof value === 'object' ? JSON.stringify(value) : null; }
function jsonArray(value) { return Array.isArray(value) ? JSON.stringify([...value].sort()) : null; }

function classifyMilitary(aircraft) {
  if (!Number.isSafeInteger(aircraft.dbFlags)) {
    return { military: null, provenance: 'unknown' };
  }
  return { military: (aircraft.dbFlags & 1) !== 0 ? 1 : 0, provenance: 'readsb_dbflags' };
}

function normalizeAircraft(aircraft, maxSeenSeconds) {
  const hex = text(aircraft.hex)?.toUpperCase();
  const seen = finite(aircraft.seen);
  if (!hex || !/^[0-9A-F]{6}$/.test(hex) || seen === null || seen < 0 || seen > maxSeenSeconds) return null;
  const lat = finite(aircraft.lat);
  const lon = finite(aircraft.lon);
  const seenPos = finite(aircraft.seen_pos);
  const validCoordinates = lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  const positioned = validCoordinates && seenPos !== null && seenPos >= 0 && seenPos <= maxSeenSeconds;
  const classification = classifyMilitary(aircraft);
  const navModesJson = jsonArray(aircraft.nav_modes);
  const sourceFieldsJson = JSON.stringify({ mlat: Array.isArray(aircraft.mlat) ? aircraft.mlat : [], tisb: Array.isArray(aircraft.tisb) ? aircraft.tisb : [] });
  const quality = {
    version: anyInteger(aircraft.version), nic: anyInteger(aircraft.nic), nic_baro: anyInteger(aircraft.nic_baro), nac_p: anyInteger(aircraft.nac_p),
    nac_v: anyInteger(aircraft.nac_v), sil: anyInteger(aircraft.sil), sil_type: text(aircraft.sil_type), gva: anyInteger(aircraft.gva),
    sda: anyInteger(aircraft.sda), rc: finite(aircraft.rc),
  };
  const state = {
    callsign: text(aircraft.flight), squawk: text(aircraft.squawk), category: text(aircraft.category),
    readsb_type: text(aircraft.type), addr_type: text(aircraft.addr_type), dbflags: Number.isSafeInteger(aircraft.dbFlags) ? aircraft.dbFlags : null,
    military: classification.military, military_provenance: classification.provenance,
    position_state: positioned ? 'positioned' : 'positionless', emergency: text(aircraft.emergency), alert: anyInteger(aircraft.alert), spi: anyInteger(aircraft.spi),
    nav_qnh: finite(aircraft.nav_qnh), nav_altitude_mcp: finite(aircraft.nav_altitude_mcp),
    nav_altitude_fms: finite(aircraft.nav_altitude_fms), nav_heading: finite(aircraft.nav_heading), nav_modes_json: navModesJson,
  };
  return {
    hex, state, seen, seen_pos: seenPos, lat: positioned ? lat : null, lon: positioned ? lon : null,
    messages: integer(aircraft.messages), rssi: finite(aircraft.rssi), alt_baro: aircraft.alt_baro ?? null,
    alt_geom: finite(aircraft.alt_geom), gs: finite(aircraft.gs), track: finite(aircraft.track),
    baro_rate: finite(aircraft.baro_rate), geom_rate: finite(aircraft.geom_rate), emergency: state.emergency,
    alert: state.alert, spi: state.spi, ...quality,
    true_heading: finite(aircraft.true_heading), mag_heading: finite(aircraft.mag_heading), ias: finite(aircraft.ias), tas: finite(aircraft.tas),
    mach: finite(aircraft.mach), roll: finite(aircraft.roll), track_rate: finite(aircraft.track_rate), calc_track: finite(aircraft.calc_track),
    nav_qnh: state.nav_qnh, nav_altitude_mcp: state.nav_altitude_mcp, nav_altitude_fms: state.nav_altitude_fms,
    nav_heading: state.nav_heading, nav_modes_json: navModesJson, oat: finite(aircraft.oat), tat: finite(aircraft.tat),
    wind_direction: finite(aircraft.wd), wind_speed: finite(aircraft.ws),
    source_fields_json: sourceFieldsJson,
  };
}

function nested(object, ...keys) { let value = object; for (const key of keys) value = value && typeof value === 'object' ? value[key] : null; return value; }
function pair(value, index) { return Array.isArray(value) ? integer(value[index]) : null; }

function normalizeStats(stats) {
  if (!stats || !stats.last1min || !stats.total) throw new Error('stats.json must contain last1min and total objects');
  const readsbNow = finite(stats.now), minute = stats.last1min, total = stats.total;
  if (readsbNow === null) throw new Error('stats.json must contain a numeric now timestamp');
  const totalStart = finite(total.start);
  return {
    readsb_now: readsbNow, receiver_uptime_seconds: totalStart === null ? null : Math.max(0, readsbNow - totalStart),
    gain_db: finite(stats.gain_db), estimated_ppm: finite(stats.estimated_ppm), aircraft_with_pos: integer(stats.aircraft_with_pos),
    aircraft_without_pos: integer(stats.aircraft_without_pos), aircraft_count_by_type_json: json(stats.aircraft_count_by_type),
    window_start: finite(minute.start), window_end: finite(minute.end), messages: integer(minute.messages), messages_valid: integer(minute.messages_valid),
    position_count_total: integer(minute.position_count_total), position_count_by_type_json: json(minute.position_count_by_type),
    max_distance_m: finite(minute.max_distance), tracks_all: integer(nested(minute, 'tracks', 'all')),
    tracks_single_message: integer(nested(minute, 'tracks', 'single_message')),
    local_accepted_0: pair(nested(minute, 'local', 'accepted'), 0), local_accepted_1: pair(nested(minute, 'local', 'accepted'), 1),
    local_modeac: integer(nested(minute, 'local', 'modeac')), local_modes: integer(nested(minute, 'local', 'modes')),
    local_bad: integer(nested(minute, 'local', 'bad')), local_unknown_icao: integer(nested(minute, 'local', 'unknown_icao')),
    local_signal_dbfs: finite(nested(minute, 'local', 'signal')), local_noise_dbfs: finite(nested(minute, 'local', 'noise')),
    local_peak_signal_dbfs: finite(nested(minute, 'local', 'peak_signal')), local_strong_signals: integer(nested(minute, 'local', 'strong_signals')),
    local_samples_dropped: integer(nested(minute, 'local', 'samples_dropped')), local_samples_lost: integer(nested(minute, 'local', 'samples_lost')),
    local_samples_processed: integer(nested(minute, 'local', 'samples_processed')),
    remote_accepted_0: pair(nested(minute, 'remote', 'accepted'), 0), remote_accepted_1: pair(nested(minute, 'remote', 'accepted'), 1),
    remote_modeac: integer(nested(minute, 'remote', 'modeac')), remote_modes: integer(nested(minute, 'remote', 'modes')),
    remote_bad: integer(nested(minute, 'remote', 'bad')), remote_bytes_in: integer(nested(minute, 'remote', 'bytes_in')),
    cpr_airborne: integer(nested(minute, 'cpr', 'airborne')), cpr_surface: integer(nested(minute, 'cpr', 'surface')),
    cpr_global_ok: integer(nested(minute, 'cpr', 'global_ok')), cpr_global_bad: integer(nested(minute, 'cpr', 'global_bad')),
    cpr_global_range: integer(nested(minute, 'cpr', 'global_range')), cpr_global_speed: integer(nested(minute, 'cpr', 'global_speed')),
    cpr_local_ok: integer(nested(minute, 'cpr', 'local_ok')), cpr_local_range: integer(nested(minute, 'cpr', 'local_range')),
    cpr_local_speed: integer(nested(minute, 'cpr', 'local_speed')), total_messages: integer(total.messages),
    total_messages_valid: integer(total.messages_valid), total_position_count: integer(total.position_count_total),
    total_local_samples_dropped: integer(nested(total, 'local', 'samples_dropped')), total_local_samples_lost: integer(nested(total, 'local', 'samples_lost')),
    cpu_json: json(minute.cpu),
  };
}

class ReadsbStore {
  constructor(databasePath = DEFAULTS.databasePath, options = {}) {
    this.db = new DatabaseSync(databasePath);
    this.options = { ...DEFAULTS, ...options, databasePath };
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (databasePath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA wal_autocheckpoint = 1000');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(SCHEMA);
      this._migrate();
      this.db.exec('PRAGMA user_version = 2');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
    this.processSnapshot = (snapshot, observedAt) => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = this._processSnapshot(snapshot, observedAt);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    };
  }

  _migrate() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(readsb_samples)').all().map((row) => row.name));
    for (const [name, type] of Object.entries(SAMPLE_MIGRATIONS)) if (!columns.has(name)) this.db.exec(`ALTER TABLE readsb_samples ADD COLUMN ${name} ${type}`);
  }

  closeOrphans(at = Date.now() / 1000) {
    return this.db.prepare("UPDATE readsb_encounters SET closed_at = ?, close_reason = 'collector_restart' WHERE closed_at IS NULL").run(at).changes;
  }

  closeForShutdown(at = Date.now() / 1000) {
    return this.db.prepare("UPDATE readsb_encounters SET closed_at = ?, close_reason = 'collector_shutdown' WHERE closed_at IS NULL").run(at).changes;
  }

  _processSnapshot(snapshot, observedAt = Date.now() / 1000) {
    if (!snapshot || !Array.isArray(snapshot.aircraft)) throw new Error('aircraft.json must contain an aircraft array');
    const readsbNow = finite(snapshot.now);
    if (readsbNow !== null) {
      const prior = this.db.prepare("SELECT last_readsb_now FROM readsb_ingestion_state WHERE source = 'aircraft'").get();
      if (prior && readsbNow <= prior.last_readsb_now) {
        return { qualifying: 0, saved: false, reason: readsbNow === prior.last_readsb_now ? 'duplicate_source_timestamp' : 'stale_source_timestamp' };
      }
    }
    const present = new Set();
    for (const raw of snapshot.aircraft) {
      const aircraft = normalizeAircraft(raw, this.options.maxSeenSeconds);
      if (!aircraft) continue;
      present.add(aircraft.hex);
      this._observe(aircraft, observedAt, readsbNow);
    }
    const open = this.db.prepare('SELECT id, hex, last_seen_at FROM readsb_encounters WHERE closed_at IS NULL').all();
    const close = this.db.prepare("UPDATE readsb_encounters SET closed_at = ?, close_reason = 'absence_timeout' WHERE id = ?");
    for (const encounter of open) {
      if (!present.has(encounter.hex) && observedAt - encounter.last_seen_at >= this.options.encounterCloseSeconds) close.run(observedAt, encounter.id);
    }
    if (readsbNow !== null) this.db.prepare(`INSERT INTO readsb_ingestion_state (source, last_readsb_now, last_observed_at)
      VALUES ('aircraft', ?, ?) ON CONFLICT(source) DO UPDATE SET last_readsb_now = excluded.last_readsb_now, last_observed_at = excluded.last_observed_at`).run(readsbNow, observedAt);
    return { qualifying: present.size, saved: true, reason: 'processed' };
  }

  _observe(a, at, readsbNow) {
    let encounter = this.db.prepare('SELECT * FROM readsb_encounters WHERE hex = ? AND closed_at IS NULL').get(a.hex);
    const isNew = !encounter;
    if (isNew) {
      const info = this.db.prepare(`INSERT INTO readsb_encounters
        (hex, first_seen_at, last_seen_at, first_callsign, last_callsign, military, military_provenance)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(a.hex, at, at, a.state.callsign, a.state.callsign, a.state.military, a.state.military_provenance);
      encounter = this.db.prepare('SELECT * FROM readsb_encounters WHERE id = ?').get(info.lastInsertRowid);
    }
    let delta = 0;
    if (a.messages !== null && encounter.last_messages !== null && a.messages >= encounter.last_messages) delta = a.messages - encounter.last_messages;
    const oldState = encounter.last_state_json ? JSON.parse(encounter.last_state_json) : null;
    const changed = !oldState || Object.keys(a.state).some((key) => oldState[key] !== a.state[key]);
    const periodic = encounter.last_sample_at === null || at - encounter.last_sample_at >= this.options.periodicSnapshotSeconds;
    const saveSample = isNew || changed || periodic;
    const positioned = a.state.position_state === 'positioned';
    this.db.prepare(`UPDATE readsb_encounters SET
      last_seen_at = ?, sample_count = sample_count + 1, total_message_delta = total_message_delta + ?,
      first_position_at = CASE WHEN ? AND first_position_at IS NULL THEN ? ELSE first_position_at END,
      last_position_at = CASE WHEN ? THEN ? ELSE last_position_at END,
      positioned_poll_count = positioned_poll_count + ?, positionless_poll_count = positionless_poll_count + ?,
      last_callsign = ?, military = ?, military_provenance = ?,
      min_rssi = CASE WHEN ? IS NULL THEN min_rssi WHEN min_rssi IS NULL OR ? < min_rssi THEN ? ELSE min_rssi END,
      max_rssi = CASE WHEN ? IS NULL THEN max_rssi WHEN max_rssi IS NULL OR ? > max_rssi THEN ? ELSE max_rssi END,
      rssi_sum = rssi_sum + COALESCE(?, 0), rssi_count = rssi_count + CASE WHEN ? IS NULL THEN 0 ELSE 1 END,
      last_messages = ?, last_sample_at = CASE WHEN ? THEN ? ELSE last_sample_at END, last_state_json = ? WHERE id = ?`).run(
      at, delta, positioned ? 1 : 0, at, positioned ? 1 : 0, at, positioned ? 1 : 0, positioned ? 0 : 1,
      a.state.callsign, a.state.military, a.state.military_provenance,
      a.rssi, a.rssi, a.rssi, a.rssi, a.rssi, a.rssi, a.rssi, a.rssi,
      a.messages, saveSample ? 1 : 0, at, JSON.stringify(a.state), encounter.id,
    );
    if (saveSample) this._insertSample(encounter.id, a, at, readsbNow, delta);
  }

  _insertSample(encounterId, a, at, readsbNow, delta) {
    const fields = [
      'sampled_at', 'readsb_now', 'encounter_id', 'hex', 'callsign', 'squawk', 'category', 'readsb_type', 'addr_type', 'dbflags',
      'military', 'military_provenance', 'position_state', 'messages', 'message_delta', 'rssi', 'seen', 'seen_pos', 'lat', 'lon',
      'alt_baro', 'alt_geom', 'gs', 'track', 'baro_rate', 'geom_rate', 'emergency', 'alert', 'spi', 'version', 'nic', 'nic_baro',
      'nac_p', 'nac_v', 'sil', 'sil_type', 'gva', 'sda', 'rc', 'true_heading', 'mag_heading', 'ias', 'tas', 'mach', 'roll',
      'track_rate', 'calc_track', 'nav_qnh', 'nav_altitude_mcp', 'nav_altitude_fms', 'nav_heading', 'nav_modes_json', 'oat', 'tat',
      'wind_direction', 'wind_speed', 'source_fields_json',
    ];
    const values = [
      at, readsbNow, encounterId, a.hex, a.state.callsign, a.state.squawk, a.state.category, a.state.readsb_type,
      a.state.addr_type, a.state.dbflags, a.state.military, a.state.military_provenance, a.state.position_state,
      a.messages, delta, a.rssi, a.seen, a.seen_pos, a.lat, a.lon, a.alt_baro, a.alt_geom, a.gs, a.track,
      a.baro_rate, a.geom_rate, a.emergency, a.alert, a.spi, a.version, a.nic, a.nic_baro, a.nac_p, a.nac_v, a.sil,
      a.sil_type, a.gva, a.sda, a.rc, a.true_heading, a.mag_heading, a.ias, a.tas, a.mach, a.roll, a.track_rate,
      a.calc_track, a.nav_qnh, a.nav_altitude_mcp, a.nav_altitude_fms, a.nav_heading, a.nav_modes_json, a.oat, a.tat,
      a.wind_direction, a.wind_speed, a.source_fields_json,
    ];
    this.db.prepare(`INSERT INTO readsb_samples
      (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...values);
  }

  processStats(snapshot, observedAt = Date.now() / 1000) {
    const stats = normalizeStats(snapshot);
    const latest = this.db.prepare('SELECT sampled_at, readsb_now FROM readsb_receiver_stats ORDER BY sampled_at DESC LIMIT 1').get();
    if (latest && stats.readsb_now === latest.readsb_now) return { saved: false, reason: 'duplicate_source_timestamp' };
    if (latest && observedAt - latest.sampled_at < this.options.statsSnapshotSeconds) return { saved: false, reason: 'interval' };
    const fields = ['sampled_at', ...Object.keys(stats)], values = [observedAt, ...Object.values(stats)];
    const result = this.db.prepare(`INSERT OR IGNORE INTO readsb_receiver_stats (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...values);
    return { saved: result.changes === 1, reason: result.changes === 1 ? 'inserted' : 'duplicate_source_timestamp' };
  }

  encounters(hex) { return this.db.prepare(`SELECT *, CASE WHEN rssi_count > 0 THEN rssi_sum / rssi_count END AS mean_rssi FROM readsb_encounters ${hex ? 'WHERE hex = ?' : ''} ORDER BY first_seen_at DESC`).all(...(hex ? [hex.toUpperCase()] : [])); }
  samples(hex) { return this.db.prepare(`SELECT * FROM readsb_samples ${hex ? 'WHERE hex = ?' : ''} ORDER BY sampled_at DESC`).all(...(hex ? [hex.toUpperCase()] : [])); }
  stats() { return this.db.prepare('SELECT * FROM readsb_receiver_stats ORDER BY sampled_at DESC').all(); }
  active() { return this.db.prepare('SELECT *, CASE WHEN rssi_count > 0 THEN rssi_sum / rssi_count END AS mean_rssi FROM readsb_encounters WHERE closed_at IS NULL ORDER BY last_seen_at DESC').all(); }
  checkpoint(mode = 'PASSIVE') { return this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get(); }
  close() {
    if (this.options.databasePath !== ':memory:') this.checkpoint('TRUNCATE');
    this.db.close();
  }
}

async function collect(options) {
  const store = new ReadsbStore(options.databasePath, options);
  store.closeOrphans();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      const started = Date.now();
      const result = await pollFiles(store, options);
      if (result.aircraftError) console.error(`[readsb] poll failed: ${result.aircraftError}`);
      if (result.statsError) console.error(`[readsb] stats poll failed: ${result.statsError}`);
      const remaining = Math.max(0, options.pollSeconds * 1000 - (Date.now() - started));
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  } finally { store.closeForShutdown(); store.close(); }
}

async function pollFiles(store, options, observedAt = Date.now() / 1000) {
  const result = {};
  try { result.aircraft = store.processSnapshot(JSON.parse(await fs.readFile(options.aircraftPath, 'utf8')), observedAt); }
  catch (error) { result.aircraftError = error.message; }
  try { result.stats = store.processStats(JSON.parse(await fs.readFile(options.statsPath, 'utf8')), observedAt); }
  catch (error) { result.statsError = error.message; }
  return result;
}

function parseArgs(args) {
  const options = { ...DEFAULTS };
  const positional = [];
  const map = { '--aircraft-json': 'aircraftPath', '--stats-json': 'statsPath', '--database': 'databasePath', '--poll-seconds': 'pollSeconds', '--max-seen-seconds': 'maxSeenSeconds', '--encounter-close-seconds': 'encounterCloseSeconds', '--periodic-snapshot-seconds': 'periodicSnapshotSeconds', '--stats-snapshot-seconds': 'statsSnapshotSeconds' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hex') options.hex = args[++i];
    else if (map[args[i]]) { const key = map[args[i]]; const value = args[++i]; options[key] = key.endsWith('Seconds') ? Number(value) : value; }
    else positional.push(args[i]);
  }
  return { options, positional };
}

async function runCli(args) {
  const { options, positional } = parseArgs(args);
  if (positional[0] === 'readsb') positional.shift();
  const command = positional[0];
  if (!['collect', 'active', 'encounters', 'samples', 'stats'].includes(command)) {
    throw new Error('usage: readsb-live-history <collect|active|encounters|samples|stats> [options]');
  }
  if (command === 'collect') return collect(options);
  const store = new ReadsbStore(options.databasePath, options);
  try { console.log(JSON.stringify(store[command](options.hex), null, 2)); } finally { store.close(); }
}

module.exports = { DEFAULTS, ReadsbStore, classifyMilitary, normalizeAircraft, normalizeStats, pollFiles, parseArgs, runCli };
