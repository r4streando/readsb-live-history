'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ReadsbStore, normalizeStats, pollFiles, parseArgs } = require('../lib/readsb-history');

function fixture(overrides = {}) {
  return { hex: 'ae1234', seen: 1, seen_pos: 1, lat: 18.4, lon: -66.1, messages: 100, rssi: -20, flight: 'TEST1', ...overrides };
}

function setup(options = {}) {
  const store = new ReadsbStore(':memory:', { maxSeenSeconds: 30, encounterCloseSeconds: 60, periodicSnapshotSeconds: 60, ...options });
  return store;
}

function statsFixture(overrides = {}) {
  return {
    now: 1060, gain_db: 29.7, estimated_ppm: -2.4, aircraft_with_pos: 12, aircraft_without_pos: 2,
    aircraft_count_by_type: { adsb_icao: 11, mlat: 1, mode_s: 2 },
    last1min: {
      start: 1000, end: 1060, messages: 2500, messages_valid: 2490, position_count_total: 600,
      position_count_by_type: { adsb_icao: 580, mlat: 20 }, max_distance: 450000,
      tracks: { all: 20, single_message: 3 },
      local: { accepted: [2100, 300], modeac: 900, modes: 290000, bad: 170000, unknown_icao: 118000, signal: -29.1, noise: -41.9, peak_signal: -23.4, strong_signals: 2, samples_dropped: 0, samples_lost: 1, samples_processed: 144000000 },
      remote: { accepted: [40, 1], modeac: 2, modes: 42, bad: 0, bytes_in: 900 },
      cpr: { airborne: 550, surface: 2, global_ok: 530, global_bad: 1, global_range: 2, global_speed: 0, local_ok: 15, local_range: 0, local_speed: 0 },
      cpu: { demod: 3200, reader: 1000 },
    },
    total: { start: 100, messages: 8000000, messages_valid: 7999000, position_count_total: 1600000, local: { samples_dropped: 4, samples_lost: 5 } },
    ...overrides,
  };
}

test('positioned new encounter', () => {
  const s = setup(); s.processSnapshot({ now: 1000, aircraft: [fixture()] }, 1000);
  assert.equal(s.active()[0].positioned_poll_count, 1); assert.equal(s.samples()[0].position_state, 'positioned'); s.close();
});

test('positionless new encounter', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture({ lat: undefined, lon: undefined, seen_pos: undefined })] }, 1000);
  assert.equal(s.active()[0].positionless_poll_count, 1); assert.equal(s.samples()[0].position_state, 'positionless'); s.close();
});

test('minimal fresh ICAO-only contact gets an immediate positionless lifecycle and sample', () => {
  const s = setup(); s.processSnapshot({ now: 1000, aircraft: [{ hex: 'ae9999', seen: 0.2 }] }, 1000);
  const encounter = s.active()[0], sample = s.samples()[0];
  assert.equal(encounter.hex, 'AE9999'); assert.equal(encounter.sample_count, 1);
  assert.equal(sample.position_state, 'positionless'); assert.equal(sample.callsign, null); assert.equal(sample.messages, null); s.close();
});

test('duplicate and stale aircraft source timestamps do not update lifecycle aggregates', () => {
  const s = setup();
  assert.equal(s.processSnapshot({ now: 1000, aircraft: [fixture()] }, 1000).saved, true);
  assert.equal(s.processSnapshot({ now: 1000, aircraft: [fixture({ messages: 120 })] }, 1010).reason, 'duplicate_source_timestamp');
  assert.equal(s.processSnapshot({ now: 999, aircraft: [] }, 1100).reason, 'stale_source_timestamp');
  const encounter = s.active()[0]; assert.equal(encounter.sample_count, 1); assert.equal(encounter.total_message_delta, 0); assert.equal(s.samples().length, 1); s.close();
});

test('stale aircraft ignored', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture({ seen: 31 })] }, 1000); assert.equal(s.active().length, 0); s.close();
});

test('stale seen_pos is positionless and coordinates are not persisted', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture({ seen_pos: 31 })] }, 1000);
  const row = s.samples()[0]; assert.equal(row.position_state, 'positionless'); assert.equal(row.lat, null); assert.equal(row.lon, null); s.close();
});

test('positionless to positioned transition creates sparse sample', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture({ lat: undefined, lon: undefined, seen_pos: undefined })] }, 1000);
  s.processSnapshot({ aircraft: [fixture({ messages: 105 })] }, 1010); assert.equal(s.samples().length, 2); s.close();
});

test('positioned to positionless transition creates sparse sample', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000);
  s.processSnapshot({ aircraft: [fixture({ seen_pos: 31, messages: 105 })] }, 1010); assert.equal(s.samples().length, 2); s.close();
});

for (const [name, field, value] of [['callsign', 'flight', 'NEW'], ['squawk', 'squawk', '7700'], ['category', 'category', 'A2'], ['dbFlags', 'dbFlags', 1]]) {
  test(`${name} change creates sparse sample`, () => {
    const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); s.processSnapshot({ aircraft: [fixture({ [field]: value })] }, 1010);
    assert.equal(s.samples().length, 2); s.close();
  });
}

test('periodic sparse sample', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); s.processSnapshot({ aircraft: [fixture()] }, 1060); assert.equal(s.samples().length, 2); s.close();
});

test('normal unchanged poll creates no sample', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); s.processSnapshot({ aircraft: [fixture({ messages: 110, rssi: -18 })] }, 1010); assert.equal(s.samples().length, 1); s.close();
});

test('message deltas accumulate despite sparse samples', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); s.processSnapshot({ aircraft: [fixture({ messages: 110 })] }, 1010); s.processSnapshot({ aircraft: [fixture({ messages: 125 })] }, 1020);
  assert.equal(s.active()[0].total_message_delta, 25); s.close();
});

test('message counter decrease never gives negative delta', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); s.processSnapshot({ aircraft: [fixture({ messages: 5 })] }, 1010); s.processSnapshot({ aircraft: [fixture({ messages: 8 })] }, 1020);
  assert.equal(s.active()[0].total_message_delta, 3); s.close();
});

test('absent message counter breaks the delta baseline', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); s.processSnapshot({ aircraft: [fixture({ messages: undefined })] }, 1010); s.processSnapshot({ aircraft: [fixture({ messages: 150 })] }, 1020);
  assert.equal(s.active()[0].total_message_delta, 0); s.close();
});

test('RSSI aggregates across unsaved polls', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture({ rssi: -20 })] }, 1000); s.processSnapshot({ aircraft: [fixture({ rssi: -10 })] }, 1010);
  const e = s.active()[0]; assert.equal(e.min_rssi, -20); assert.equal(e.max_rssi, -10); assert.equal(e.mean_rssi, -15); assert.equal(e.rssi_count, 2); s.close();
});

test('one missed successful poll does not close encounter', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); s.processSnapshot({ aircraft: [] }, 1010); assert.equal(s.active().length, 1); s.close();
});

test('encounter times out only after successful-poll absence', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); s.processSnapshot({ aircraft: [] }, 1060);
  assert.equal(s.active().length, 0); assert.equal(s.encounters()[0].close_reason, 'absence_timeout'); s.close();
});

test('reappearance creates a new encounter', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); s.processSnapshot({ aircraft: [] }, 1060); s.processSnapshot({ aircraft: [fixture()] }, 1070);
  assert.equal(s.encounters('ae1234').length, 2); assert.notEqual(s.encounters()[0].id, s.encounters()[1].id); s.close();
});

test('malformed snapshot throws without closing encounters', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); assert.throws(() => s.processSnapshot({ nope: [] }, 2000)); assert.equal(s.active().length, 1); s.close();
});

test('startup closes orphaned open encounters', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); assert.equal(s.closeOrphans(1010), 1);
  assert.equal(s.encounters()[0].close_reason, 'collector_restart'); assert.equal(s.encounters()[0].closed_at, 1010); s.close();
});

test('graceful shutdown closes open encounters at the known stop time', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000); assert.equal(s.closeForShutdown(1015), 1);
  assert.equal(s.encounters()[0].close_reason, 'collector_shutdown'); assert.equal(s.encounters()[0].closed_at, 1015); s.close();
});

test('military dbFlags retained with provenance', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture({ dbFlags: 1, type: 'adsb_icao', addr_type: 'adsb_icao' })] }, 1000);
  const e = s.active()[0], sample = s.samples()[0]; assert.equal(e.military, 1); assert.equal(e.military_provenance, 'readsb_dbflags'); assert.equal(sample.dbflags, 1); assert.equal(sample.readsb_type, 'adsb_icao'); s.close();
});

test('source/type change creates sparse sample', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture({ type: 'adsb_icao' })] }, 1000); s.processSnapshot({ aircraft: [fixture({ type: 'mode_s' })] }, 1010);
  assert.equal(s.samples().length, 2); s.close();
});

test('rich live fields are retained in a periodic aircraft sample', () => {
  const s = setup();
  s.processSnapshot({ now: 1000, aircraft: [fixture({
    emergency: 'none', alert: 0, spi: 0, version: 2, nic: 8, nic_baro: 1, nac_p: 10, nac_v: 2, sil: 3,
    sil_type: 'perhour', gva: 2, sda: 2, rc: 186, true_heading: 301.1, mag_heading: 313.2,
    ias: 291, tas: 480, mach: 0.8, roll: -0.2, track_rate: 0.03, calc_track: 300,
    nav_qnh: 1013.6, nav_altitude_mcp: 32000, nav_altitude_fms: 33000, nav_heading: 314.3,
    nav_modes: ['tcas', 'vnav'], oat: -36, tat: -6, wd: 165, ws: 8, mlat: ['lat', 'lon'], tisb: [],
  })] }, 1000);
  const row = s.samples()[0];
  assert.equal(row.true_heading, 301.1); assert.equal(row.nav_altitude_mcp, 32000); assert.equal(row.sil, 3);
  assert.equal(row.nav_modes_json, '["tcas","vnav"]'); assert.deepEqual(JSON.parse(row.source_fields_json), { mlat: ['lat', 'lon'], tisb: [] });
  s.close();
});

test('navigation and emergency changes trigger samples while rapid motion alone does not', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture({ nav_altitude_mcp: 30000, emergency: 'none' })] }, 1000);
  s.processSnapshot({ aircraft: [fixture({ messages: 110, rssi: -18, alt_baro: 20000, gs: 450, track: 90, nav_altitude_mcp: 30000, emergency: 'none' })] }, 1010);
  assert.equal(s.samples().length, 1);
  s.processSnapshot({ aircraft: [fixture({ nav_altitude_mcp: 32000, emergency: 'none' })] }, 1020);
  s.processSnapshot({ aircraft: [fixture({ nav_altitude_mcp: 32000, emergency: 'general' })] }, 1030);
  assert.equal(s.samples().length, 3); s.close();
});

for (const [name, initial, changed] of [
  ['emergency', { emergency: 'none' }, { emergency: 'general' }],
  ['alert', { alert: 0 }, { alert: 1 }],
  ['SPI', { spi: 0 }, { spi: 1 }],
  ['MCP altitude', { nav_altitude_mcp: 30000 }, { nav_altitude_mcp: 32000 }],
  ['FMS altitude', { nav_altitude_fms: 30000 }, { nav_altitude_fms: 31000 }],
  ['navigation heading', { nav_heading: 90 }, { nav_heading: 100 }],
  ['navigation modes', { nav_modes: ['tcas'] }, { nav_modes: ['tcas', 'vnav'] }],
]) {
  test(`${name} normalized state change creates a sparse sample`, () => {
    const s = setup(); s.processSnapshot({ aircraft: [fixture(initial)] }, 1000); s.processSnapshot({ aircraft: [fixture(changed)] }, 1010);
    assert.equal(s.samples().length, 2); s.close();
  });
}

test('continuous motion, RF, altitude, and heading changes do not independently create samples', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture({ alt_baro: 10000, baro_rate: 100, true_heading: 80 })] }, 1000);
  s.processSnapshot({ aircraft: [fixture({ lat: 18.5, lon: -66.2, messages: 150, rssi: -15, alt_baro: 11000, alt_geom: 11200, gs: 410, track: 95, baro_rate: 500, geom_rate: 450, true_heading: 96, mag_heading: 108 })] }, 1010);
  assert.equal(s.samples().length, 1); assert.equal(s.active()[0].sample_count, 2); s.close();
});

test('missing rich optional fields remain null', () => {
  const s = setup(); s.processSnapshot({ aircraft: [fixture()] }, 1000);
  const row = s.samples()[0]; assert.equal(row.true_heading, null); assert.equal(row.nav_modes_json, null); assert.equal(row.sil, null); s.close();
});

test('receiver stats ingestion retains one-minute health metrics and UTC epoch', () => {
  const s = setup(); const result = s.processStats(statsFixture(), 1061.5); const row = s.stats()[0];
  assert.equal(result.saved, true); assert.equal(row.sampled_at, 1061.5); assert.equal(new Date(row.sampled_at * 1000).toISOString(), '1970-01-01T00:17:41.500Z');
  assert.equal(row.receiver_uptime_seconds, 960); assert.equal(row.messages, 2500); assert.equal(row.local_signal_dbfs, -29.1);
  assert.equal(row.aircraft_without_pos, 2); assert.equal(row.remote_accepted_1, 1); assert.deepEqual(JSON.parse(row.position_count_by_type_json), { adsb_icao: 580, mlat: 20 }); s.close();
});

test('receiver stats deduplicate source timestamps and honor the interval across calls', () => {
  const s = setup({ statsSnapshotSeconds: 60 });
  assert.equal(s.processStats(statsFixture(), 1060).saved, true);
  assert.equal(s.processStats(statsFixture(), 1070).reason, 'duplicate_source_timestamp');
  assert.equal(s.processStats(statsFixture({ now: 1070 }), 1070).reason, 'interval');
  assert.equal(s.processStats(statsFixture({ now: 1120 }), 1120).saved, true); assert.equal(s.stats().length, 2); s.close();
});

test('malformed receiver stats are rejected without adding a row', () => {
  const s = setup(); assert.throws(() => s.processStats({ now: 1 }), /last1min and total/); assert.equal(s.stats().length, 0); s.close();
  assert.throws(() => normalizeStats(statsFixture({ now: 'bad' })), /numeric now/);
});

test('file polling isolates malformed and unavailable JSON sources', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readsb-poll-')), aircraftPath = path.join(root, 'aircraft.json'), statsPath = path.join(root, 'stats.json');
  const s = setup(); await fs.writeFile(aircraftPath, JSON.stringify({ now: 1000, aircraft: [fixture()] })); await fs.writeFile(statsPath, '{bad');
  let result = await pollFiles(s, { aircraftPath, statsPath }, 1000); assert.equal(result.aircraft.qualifying, 1); assert.match(result.statsError, /JSON/); assert.equal(s.samples().length, 1);
  await fs.writeFile(statsPath, JSON.stringify(statsFixture())); await fs.unlink(aircraftPath);
  result = await pollFiles(s, { aircraftPath, statsPath }, 1060); assert.match(result.aircraftError, /ENOENT/); assert.equal(result.stats.saved, true); assert.equal(s.active().length, 1); s.close();
});

test('CLI accepts standalone command and stats sampling options', () => {
  const parsed = parseArgs(['collect', '--stats-json', '/tmp/stats.json', '--stats-snapshot-seconds', '120']);
  assert.equal(parsed.positional[0], 'collect'); assert.equal(parsed.options.statsPath, '/tmp/stats.json'); assert.equal(parsed.options.statsSnapshotSeconds, 120);
});

test('CLI parser remains compatible with legacy readsb prefix', () => {
  const parsed = parseArgs(['readsb', 'collect', '--database', '/tmp/history.sqlite3']);
  assert.deepEqual(parsed.positional, ['readsb', 'collect']); assert.equal(parsed.options.databasePath, '/tmp/history.sqlite3');
});

test('opening a Phase 1 database adds rich sample columns and receiver stats schema', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readsb-migration-')), database = path.join(root, 'history.sqlite3');
  const old = new DatabaseSync(database);
  old.exec('CREATE TABLE readsb_encounters (id INTEGER PRIMARY KEY, hex TEXT NOT NULL, first_seen_at REAL NOT NULL, last_seen_at REAL NOT NULL, closed_at REAL)');
  old.exec('CREATE TABLE readsb_samples (id INTEGER PRIMARY KEY, sampled_at REAL NOT NULL, encounter_id INTEGER NOT NULL, hex TEXT NOT NULL)');
  old.close();
  const s = new ReadsbStore(database); const columns = new Set(s.db.prepare('PRAGMA table_info(readsb_samples)').all().map((row) => row.name));
  assert.ok(columns.has('true_heading')); assert.ok(columns.has('nav_altitude_mcp')); assert.ok(columns.has('sil'));
  assert.equal(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'readsb_receiver_stats'").get().name, 'readsb_receiver_stats'); s.close();
});

test('file database uses the production SQLite durability settings and schema version', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readsb-pragmas-')), database = path.join(root, 'history.sqlite3');
  const s = new ReadsbStore(database);
  assert.equal(s.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(s.db.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.equal(s.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(s.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, 1000);
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 2);
  s.close();
});
