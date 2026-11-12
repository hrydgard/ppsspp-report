'use strict';

const pool = require('./db');

// Ingest counters: what happened to each incoming report (stored, or why it was dropped), per UTC hour.  Counted in memory
// and added to report_stats once a minute (and at shutdown), so a crash loses at most a minute.  Shown on /stats.
const FLUSH_INTERVAL = 60 * 1000;

// Outcomes, in the order /stats lists them.  Anything else is counted too, but listed last.
const OUTCOMES = {
	stored: 'Stored',
	too_old_version: 'Dropped: version older than the cutoff',
	blocked_version: 'Dropped: blocked version',
	blocked_kind: 'Dropped: blocked message kind',
	homebrew_no_version: 'Dropped: homebrew without a version',
	invalid_game: 'Dropped: invalid game ID or title',
	failed_verification: 'Dropped: failed verification (corrupted)',
	unknown_rating: 'Dropped: unknown compatibility rating',
	bad_upload: 'Error: unreadable upload',
	error: 'Error: other',
};

let pending = new Map();
// day|type|version -> count: every incoming report by the version it says it's from, before any dropping.
let pendingVersions = new Map();

const intervalID = setInterval(flush, FLUSH_INTERVAL);
pool.onEnd(() => clearInterval(intervalID));

function hourOf(date)
{
	const d = new Date(date);
	d.setUTCMinutes(0, 0, 0);
	// MySQL DATETIME literal, UTC.
	return d.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

module.exports.count = function (type, outcome)
{
	const key = hourOf(Date.now()) + '|' + type + '|' + outcome;
	pending.set(key, (pending.get(key) || 0) + 1);
};

// Counted before anything is dropped, so it shows which versions still send reports (biased: only users with reporting on).
module.exports.countVersion = function (type, version)
{
	let v = version === undefined || version === null ? '' : String(version).trim();
	v = v.replace(/[^\x21-\x7e]/g, '?').substr(0, 32);
	const key = hourOf(Date.now()).substr(0, 10) + '|' + type + '|' + (v || '(none)');
	pendingVersions.set(key, (pendingVersions.get(key) || 0) + 1);
};

async function flushVersions()
{
	if (pendingVersions.size == 0)
		return;
	const batch = pendingVersions;
	pendingVersions = new Map();
	const rows = [];
	for (const [key, n] of batch)
	{
		const [day, type, ...rest] = key.split('|');
		rows.push([day, type, rest.join('|'), n]);
	}
	try
	{
		await pool.query(`
			INSERT INTO report_version_stats (day, type, version, count)
			VALUES ?
			ON DUPLICATE KEY UPDATE count = count + VALUES(count)`, [rows]);
	}
	catch (err)
	{
		for (const [key, n] of batch)
			pendingVersions.set(key, (pendingVersions.get(key) || 0) + n);
		console.error('Error saving version stats', err);
	}
}

async function flush()
{
	await Promise.all([flushOutcomes(), flushVersions()]);
}

async function flushOutcomes()
{
	if (pending.size == 0)
		return;
	const batch = pending;
	pending = new Map();
	const rows = [];
	for (const [key, n] of batch)
	{
		const [hour, type, outcome] = key.split('|');
		rows.push([hour, type, outcome, n]);
	}
	try
	{
		await pool.query(`
			INSERT INTO report_stats (hour, type, outcome, count)
			VALUES ?
			ON DUPLICATE KEY UPDATE count = count + VALUES(count)`, [rows]);
	}
	catch (err)
	{
		// Put them back for the next try.
		for (const [key, n] of batch)
			pending.set(key, (pending.get(key) || 0) + n);
		console.error('Error saving report stats', err);
	}
}
module.exports.flush = flush;

module.exports.OUTCOMES = OUTCOMES;

// Totals per type and outcome over several periods, plus per-hour totals for the last 48 hours.  Includes the unsaved counts.
module.exports.getSummary = async function ()
{
	const [rows] = await pool.query(`
		SELECT type, outcome,
			SUM(IF(hour >= UTC_TIMESTAMP() - INTERVAL 1 HOUR, count, 0)) AS h1,
			SUM(IF(hour >= UTC_TIMESTAMP() - INTERVAL 24 HOUR, count, 0)) AS h24,
			SUM(IF(hour >= UTC_TIMESTAMP() - INTERVAL 7 DAY, count, 0)) AS d7,
			SUM(IF(hour >= UTC_TIMESTAMP() - INTERVAL 30 DAY, count, 0)) AS d30,
			SUM(count) AS total,
			MIN(hour) AS since
		FROM report_stats
		GROUP BY type, outcome`, null);
	const [hourly] = await pool.query(`
		SELECT hour, type, SUM(IF(outcome = 'stored', count, 0)) AS n_stored, SUM(count) AS n_received
		FROM report_stats
		WHERE hour >= UTC_TIMESTAMP() - INTERVAL 48 HOUR
		GROUP BY hour, type
		ORDER BY hour DESC, type`, null);

	// "Last hour" etc. are rolling: the current, partial hour counts fully, the hour bucket that started 1/24 hours ago too.
	const totals = rows.map(r => ({
		type: r.type, outcome: r.outcome,
		h1: Number(r.h1), h24: Number(r.h24), d7: Number(r.d7), d30: Number(r.d30), total: Number(r.total), since: r.since,
	}));
	const hours = hourly.map(r => ({ hour: r.hour, type: r.type, stored: Number(r.n_stored), received: Number(r.n_received) }));

	// Counts from the last minute that aren't saved yet.
	const now = hourOf(Date.now());
	for (const [key, n] of pending)
	{
		const [hour, type, outcome] = key.split('|');
		let t = totals.find(r => r.type == type && r.outcome == outcome);
		if (!t)
			totals.push(t = { type, outcome, h1: 0, h24: 0, d7: 0, d30: 0, total: 0, since: null });
		t.total += n;
		t.d30 += n;
		t.d7 += n;
		t.h24 += n;
		if (hour == now)
			t.h1 += n;
		let h = hours.find(r => r.type == type && hourOf(r.hour) == hour);
		if (!h)
			hours.unshift(h = { hour: new Date(hour.replace(' ', 'T') + 'Z'), type, stored: 0, received: 0 });
		h.received += n;
		if (outcome == 'stored')
			h.stored += n;
	}
	return { totals, hours };
};

// Incoming reports per version over the last 1/7/30 days (by UTC day, today included), including unsaved counts.
module.exports.getVersionSummary = async function ()
{
	const [rows] = await pool.query(`
		SELECT type, version,
			SUM(IF(day >= UTC_DATE(), count, 0)) AS d1,
			SUM(IF(day >= UTC_DATE() - INTERVAL 6 DAY, count, 0)) AS d7,
			SUM(IF(day >= UTC_DATE() - INTERVAL 29 DAY, count, 0)) AS d30
		FROM report_version_stats
		WHERE day >= UTC_DATE() - INTERVAL 29 DAY
		GROUP BY type, version`, null);
	const out = rows.map(r => ({ type: r.type, version: r.version, d1: Number(r.d1), d7: Number(r.d7), d30: Number(r.d30) }));
	const today = hourOf(Date.now()).substr(0, 10);
	for (const [key, n] of pendingVersions)
	{
		const [day, type, ...rest] = key.split('|');
		const version = rest.join('|');
		let r = out.find(x => x.type == type && x.version == version);
		if (!r)
			out.push(r = { type, version, d1: 0, d7: 0, d30: 0 });
		r.d30 += n;
		r.d7 += n;
		if (day == today)
			r.d1 += n;
	}
	return out;
};
