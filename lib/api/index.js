'use strict';

// Read-only JSON API over the same data as the /logs pages, meant for scripts and agents looking for bugs to fix.
// See API.md (and GET /api/v1, which describes itself).

const data = require('../logs/data');
const lookups = require('../lookups');
const limits = require('../limits');
const pool = require('../db');
const crypto = require('crypto');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const RECENT_DETAILS = 10;
// Every API query stops after this long (MySQL optimizer hint), so a heavy request can't stall the server.
const MAX_EXECUTION_MS = 10000;

let g_server;

module.exports.addRoutes = function (server)
{
	g_server = server;
	server.getSecure('/api/v1', api_index);
	server.getSecure('/api/v1/kinds', api_kinds);
	server.getSecure('/api/v1/kinds/:id_msg_kind', api_kind);
	server.getSecure('/api/v1/kinds/:id_msg_kind/groups', api_kind_groups);
	server.getSecure('/api/v1/kinds/:id_msg_kind/messages', api_kind_messages);
	server.getSecure('/api/v1/messages/:id_msg', api_message);
	server.app.post('/api/v1/resolve', api_resolve);
};

class BadRequest extends Error {}
class NotFound extends Error {}
class Unauthorized extends Error {}
class Unavailable extends Error {}

function handler(fn)
{
	return async function (req, res)
	{
		res.setHeader('Content-Type', 'application/json; charset=utf-8');
		try
		{
			const body = await fn(req);
			res.end(JSON.stringify(body, null, req.query.pretty !== undefined ? 2 : 0));
		}
		catch (err)
		{
			let status = 500;
			let message = 'Internal error';
			if (err instanceof BadRequest)
			{
				status = 400;
				message = err.message;
			}
			else if (err instanceof NotFound)
			{
				status = 404;
				message = err.message;
			}
			else if (err instanceof Unauthorized)
			{
				status = 401;
				message = err.message;
			}
			else if (err instanceof Unavailable)
			{
				status = 503;
				message = err.message;
			}
			else if (err && err.errno === 3024)
			{
				status = 503;
				message = 'Query took too long; narrow it down (min_version, since, status, text).';
			}
			else
				console.error(err);
			res.status(status).end(JSON.stringify({ error: message }));
		}
	};
}

const api_index = handler(async () => ({
	description: 'Read-only JSON API for PPSSPP crash/log reports (report.ppsspp.org). See also the HTML pages under /logs.',
	concepts: {
		kind: 'A message template (format string) as logged by PPSSPP, e.g. "Error in shader program link: info: %s ...". Listed on /logs/kinds.',
		message: 'One stored row per (kind, game, exact formatted text). Repeat reports of the same text from the same game only increase hit counters, per version/platform/GPU/CPU/config.',
		hits: 'Number of reports, summed over versions. Each per-version counter stops at 65,535, so very common messages are undercounted.',
		status: 'new | resolved | reoccurring. Set by hand ("fixed in version X"); a resolved message reported again from that version or newer becomes reoccurring. Default filter: new + reoccurring. Use status=any for everything.',
		text_truncated: 'Texts are cut at 4,096 characters when stored; long shader sources often are.',
		dropped: 'Reports from PPSSPP older than v1.19.0, and kinds marked blocked, are no longer stored.',
	},
	endpoints: {
		'GET /api/v1/kinds': 'All kinds that have messages matching status: id, template, blocked, games. Params: status, min_version (only kinds reported from that version or newer; games counted from those versions).',
		'GET /api/v1/kinds/:id': 'One kind: template, blocked, message count.',
		'GET /api/v1/kinds/:id/groups': 'Distinct texts of a kind with games, messages, hits, latest report; most hits first. Params: status, min_version, max_version, since, page.',
		'GET /api/v1/kinds/:id/messages': 'Full messages of a kind, newest first, with version/platform/GPU/CPU details. Params: status, min_version, max_version, since, text (exact), limit (max 100), before (cursor; use "next").',
		'GET /api/v1/messages/:id': 'One message with all details, including the PPSSPP settings (configs) it was reported with.',
		'POST /api/v1/resolve': 'Mark messages fixed (needs Authorization: Bearer <secret>). JSON body: kind (id, required), version ' +
			'(fixed-in version, required), optional text (exact) or message (id) to narrow it, optional dry_run. Messages already reported ' +
			'from a newer version than that are skipped. A resolved message reported again from that version or newer becomes reoccurring.',
	},
	parameters: {
		status: 'new, resolved, reoccurring or any (default: new + reoccurring)',
		min_version: 'e.g. v1.20.4 or 1.20.4: only count reports from this version or newer (dev builds after it, like v1.20.4-605-gabc, count as newer)',
		max_version: 'same, upper bound (inclusive; dev builds after it count as newer, so are excluded)',
		since: 'YYYY-MM-DD: only messages reported (from those versions) on or after this date',
		pretty: 'any value: indent the JSON',
	},
	examples: [
		'/api/v1/kinds/967/groups?min_version=v1.20.4',
		'/api/v1/kinds/967/messages?min_version=v1.20.4&limit=10',
		'/api/v1/messages/2791541',
	],
}));

const api_kinds = handler(async (req) =>
{
	const args = {};
	if (req.query.status !== undefined)
		args.status = parseStatus(req.query.status);
	if (req.query.min_version !== undefined)
		args.min_value = parseVersion(req.query.min_version, 'min_version');
	const rows = await data.getKindList(args);
	return {
		kinds: rows.map(row => ({
			id: row.id_msg_kind,
			template: row.message,
			blocked: !!row.blocked,
			games: Number(row.games),
			url: '/api/v1/kinds/' + row.id_msg_kind,
		})),
	};
});

const api_kind = handler(async (req) =>
{
	const kind = await getKind(req.params.id_msg_kind);
	const args = { id_msg_kind: kind.id };
	if (req.query.status !== undefined)
		args.status = parseStatus(req.query.status);
	return Object.assign(kind, {
		messages: Number(await data.countMessages(args)),
		html: '/logs/kind/' + kind.id,
		groups: '/api/v1/kinds/' + kind.id + '/groups',
		messages_url: '/api/v1/kinds/' + kind.id + '/messages',
	});
});

const api_kind_groups = handler(async (req) =>
{
	const kind = await getKind(req.params.id_msg_kind);
	const args = Object.assign({ id_msg_kind: kind.id }, parseFilters(req));
	args.page = parsePositive(req.query.page, 'page', 1000) || 1;
	const result = await data.getGroupedKind(args);
	return {
		kind,
		filters: describeFilters(args),
		page: args.page,
		groups: result.rows.map(row => ({
			text: row.message,
			text_truncated: String(row.message).length >= limits.FORMATTED_MESSAGE_LENGTH,
			games: Number(row.games),
			messages: Number(row.messages),
			hits: Number(row.hits),
			latest_report: iso(row.latest_report),
			example_message: '/api/v1/messages/' + row.id_msg,
			messages_url: makeUrl('/api/v1/kinds/' + kind.id + '/messages', Object.assign(filterQuery(req), { text: row.message })),
		})),
		next: result.more ? makeUrl(req.path, Object.assign(filterQuery(req), { page: args.page + 1 })) : null,
	};
});

const api_kind_messages = handler(async (req) =>
{
	const kind = await getKind(req.params.id_msg_kind);
	const args = Object.assign({ id_msg_kind: kind.id }, parseFilters(req));
	if (typeof req.query.text == 'string')
	{
		if (req.query.text.length > limits.FORMATTED_MESSAGE_LENGTH)
			throw new BadRequest('text is longer than any stored text');
		args.text = req.query.text;
	}
	const before = parsePositive(req.query.before, 'before');
	if (before)
		args.before = before;
	const limit = parsePositive(req.query.limit, 'limit', MAX_LIMIT) || DEFAULT_LIMIT;

	const [list, total] = await Promise.all([
		data.getRecentMessageList(args),
		before ? null : data.countMessages(args),
	]);
	const rows = list.slice(0, limit);
	const messages = await describeMessages(rows.map(r => r.id_msg), false);

	let next = null;
	if (rows.length == limit && (list.length > limit || list.length >= 100))
		next = makeUrl(req.path, Object.assign(filterQuery(req), { limit, before: rows[rows.length - 1].id_msg }));

	return {
		kind,
		filters: describeFilters(args),
		total: total === null ? null : Number(total),
		messages,
		next,
	};
});

const api_message = handler(async (req) =>
{
	const id_msg = parsePositive(req.params.id_msg, 'id');
	const [message] = await describeMessages([id_msg], true);
	if (!message)
		throw new NotFound('No such message');
	return message;
});

// POST /api/v1/resolve: set status 'resolved' with a fixed-in version on a kind's open messages (or one text / one message).
// Messages already reported from a version newer than the fix are left alone: the fix evidently didn't cover them.
// When later reported from the fixed-in version or newer, report_message_hit turns a resolved message into 'reoccurring'.
const api_resolve = handler(async (req) =>
{
	checkSecret(req);
	const body = req.body || {};

	const kind = await getKind(body.kind);
	if (body.version === undefined)
		throw new BadRequest('version (the version the fix is in, e.g. v1.20.5) is required');
	const version_value = parseVersion(body.version, 'version');
	if (body.text !== undefined && body.message !== undefined)
		throw new BadRequest('give text or message, not both');
	const dry_run = body.dry_run === true || body.dry_run === 'true' || body.dry_run === '1' || body.dry_run === 1;

	// Same rule as the old resolve_message_* procedures: open messages, or reoccurring ones resolved at an older version.
	const clauses = [
		'm.id_msg_kind = :id_msg_kind',
		"m.status IN ('new', 'reoccurring')",
		"(m.status = 'new' OR m.resolved_version_value <= :version_value)",
	];
	const args = { id_msg_kind: kind.id, version_value };
	if (body.text !== undefined)
	{
		clauses.push('m.formatted_hash = UNHEX(SHA1(:text)) AND m.formatted_message = :text');
		args.text = String(body.text);
	}
	if (body.message !== undefined)
	{
		clauses.push('m.id_msg = :id_msg');
		args.id_msg = parsePositive(body.message, 'message');
	}
	const seenAfter = `EXISTS (
		SELECT 1
		FROM report_message_versions AS mv
			INNER JOIN versions AS v USING (id_version)
		WHERE mv.id_msg = m.id_msg
			AND v.value > :version_value
	)`;

	const [[counts]] = await pool.query(`
		SELECT COUNT(*) AS matching, COALESCE(SUM(${seenAfter}), 0) AS seen_after
		FROM report_messages AS m
		WHERE ${clauses.join(' AND ')}`, args);
	const matching = Number(counts.matching);
	const seen_after = Number(counts.seen_after);

	let resolved = matching - seen_after;
	if (!dry_run && resolved > 0)
	{
		const [result] = await pool.query(`
			UPDATE report_messages AS m
			SET m.status = 'resolved', m.resolved_version_value = :version_value
			WHERE ${clauses.join(' AND ')}
				AND NOT ${seenAfter}`, args);
		resolved = result.affectedRows;
	}

	const summary = {
		kind: kind.id,
		version_value,
		scope: args.id_msg ? { message: args.id_msg } : (args.text !== undefined ? { text: args.text } : 'whole kind'),
		dry_run,
		matching_open_messages: matching,
		skipped_seen_in_newer_version: seen_after,
		[dry_run ? 'would_resolve' : 'resolved']: resolved,
	};
	console.log(new Date().toISOString() + ' API resolve from ' + req.ip + ': ' + JSON.stringify(Object.assign({}, summary,
		args.text !== undefined ? { scope: { text: args.text.substr(0, 80) } } : {})));
	return summary;
});

// The write secret is REPORT_API_SECRET in ./config (not in git).  No secret configured = writes disabled.
function checkSecret(req)
{
	const secret = process.env.REPORT_API_SECRET || '';
	if (secret.length < 32)
		throw new Unavailable('Write API is not enabled on this server');
	if (process.env.OPENSHIFT_EXTERNAL_URL && !req.secure)
		throw new BadRequest('Use https');
	const header = String(req.get('authorization') || '');
	const given = header.startsWith('Bearer ') ? header.substr(7).trim() : '';
	const a = crypto.createHash('sha256').update(given).digest();
	const b = crypto.createHash('sha256').update(secret).digest();
	if (!given || !crypto.timingSafeEqual(a, b))
		throw new Unauthorized('Missing or wrong secret (Authorization: Bearer <secret>)');
}

// Full details for messages, in the order given.
async function describeMessages(ids, withConfigs)
{
	if (ids.length == 0)
		return [];
	const hint = `/*+ MAX_EXECUTION_TIME(${MAX_EXECUTION_MS}) */`;

	const [[base], [versions], [platforms], [gpus], [cpus]] = await Promise.all([
		pool.query(`
			SELECT ${hint} m.id_msg, m.id_msg_kind, m.id_game, g.title AS game_title, m.status, m.resolved_version_value,
				m.formatted_message, mk.message AS template
			FROM report_messages AS m
				INNER JOIN games AS g USING (id_game)
				INNER JOIN report_message_kinds AS mk USING (id_msg_kind)
			WHERE m.id_msg IN (:ids)`, { ids }),
		pool.query(`
			SELECT ${hint} *
			FROM (
				SELECT mv.id_msg, v.title AS version, mv.hits, mv.first_report, mv.latest_report,
					ROW_NUMBER() OVER (PARTITION BY mv.id_msg ORDER BY mv.latest_report DESC) AS n,
					COUNT(*) OVER (PARTITION BY mv.id_msg) AS total,
					SUM(mv.hits) OVER (PARTITION BY mv.id_msg) AS total_hits,
					MIN(mv.first_report) OVER (PARTITION BY mv.id_msg) AS first_ever,
					MAX(mv.latest_report) OVER (PARTITION BY mv.id_msg) AS latest_ever
				FROM report_message_versions AS mv
					INNER JOIN versions AS v USING (id_version)
				WHERE mv.id_msg IN (:ids)
			) AS x
			WHERE n <= :recent`, { ids, recent: RECENT_DETAILS }),
		recentDetails(hint, 'report_message_platforms', 'id_platform', 'platforms', 'p.title AS name', ids),
		recentDetails(hint, 'report_message_gpus', 'id_gpu', 'gpus',
			'p.short_desc AS vendor, p.nickname AS name, p.kind, LEFT(p.long_desc, 300) AS driver', ids),
		recentDetails(hint, 'report_message_cpus', 'id_cpu', 'cpus', 'p.summary AS name', ids),
	]);

	let configs = {};
	if (withConfigs)
		configs = await recentConfigs(hint, ids);

	const byId = new Map(base.map(row => [row.id_msg, row]));
	const group = (rows) =>
	{
		const out = new Map();
		for (const row of rows)
		{
			if (!out.has(row.id_msg))
				out.set(row.id_msg, []);
			out.get(row.id_msg).push(row);
		}
		return out;
	};
	const v = group(versions), p = group(platforms), gp = group(gpus), c = group(cpus);
	const details = (list, pick) => ({
		total: list && list.length ? Number(list[0].total) : 0,
		recent: (list || []).map(row => Object.assign(pick(row), {
			hits: Number(row.hits),
			first_report: iso(row.first_report),
			latest_report: iso(row.latest_report),
		})),
	});

	const result = [];
	for (const id of ids)
	{
		const m = byId.get(Number(id));
		if (!m)
			continue;
		const vs = v.get(m.id_msg) || [];
		const text = String(m.formatted_message);
		const message = {
			id: m.id_msg,
			url: '/api/v1/messages/' + m.id_msg,
			kind: { id: m.id_msg_kind, template: m.template, url: '/api/v1/kinds/' + m.id_msg_kind },
			game: { id: m.id_game, title: m.game_title, html: '/logs/game/' + encodeURIComponent(m.id_game) },
			status: m.status,
			resolved_version_value: m.status == 'new' ? null : m.resolved_version_value,
			text,
			text_truncated: text.length >= limits.FORMATTED_MESSAGE_LENGTH,
			hits: vs.length ? Number(vs[0].total_hits) : 0,
			first_report: vs.length ? iso(vs[0].first_ever) : null,
			latest_report: vs.length ? iso(vs[0].latest_ever) : null,
			versions: details(vs, row => ({ version: row.version })),
			platforms: details(p.get(m.id_msg), row => ({ name: row.name })),
			gpus: details(gp.get(m.id_msg), row => ({ id: row.id_gpu, vendor: row.vendor, name: row.name, kind: row.kind, driver: row.driver })),
			cpus: details(c.get(m.id_msg), row => ({ name: row.name })),
		};
		if (withConfigs)
			message.configs = configs[m.id_msg] || { total: 0, recent: [] };
		result.push(message);
	}
	return result;
}

// The most recent platforms/GPUs/CPUs of each message, with how many there are in total.
async function recentDetails(hint, table, idCol, lookupTable, columns, ids)
{
	return pool.query(`
		SELECT ${hint} x.*, ${columns}
		FROM (
			SELECT l.id_msg, l.${idCol}, l.hits, l.first_report, l.latest_report,
				ROW_NUMBER() OVER (PARTITION BY l.id_msg ORDER BY l.latest_report DESC) AS n,
				COUNT(*) OVER (PARTITION BY l.id_msg) AS total
			FROM ${table} AS l
			WHERE l.id_msg IN (:ids)
		) AS x
			INNER JOIN ${lookupTable} AS p USING (${idCol})
		WHERE x.n <= :recent
		ORDER BY x.id_msg, x.n`, { ids, recent: RECENT_DETAILS });
}

// The settings of the 3 most recent configs a message was reported with (configs are deduplicated sets of settings).
async function recentConfigs(hint, ids)
{
	const [rows] = await pool.query(`
		SELECT ${hint} x.id_msg, x.id_config, x.hits, x.latest_report, x.total, s.title AS setting, d.value
		FROM (
			SELECT l.id_msg, l.id_config, l.hits, l.latest_report,
				ROW_NUMBER() OVER (PARTITION BY l.id_msg ORDER BY l.latest_report DESC) AS n,
				COUNT(*) OVER (PARTITION BY l.id_msg) AS total
			FROM report_message_configs AS l
			WHERE l.id_msg IN (:ids)
		) AS x
			INNER JOIN config_values AS cv USING (id_config)
			INNER JOIN config_settings AS s USING (id_config_setting)
			INNER JOIN config_data AS d USING (id_config_data)
		WHERE x.n <= 3
		ORDER BY x.id_msg, x.latest_report DESC, s.title`, { ids });

	const out = {};
	for (const row of rows)
	{
		const msg = out[row.id_msg] || (out[row.id_msg] = { total: Number(row.total), recent: [] });
		let config = msg.recent.find(c => c.id == row.id_config);
		if (!config)
		{
			config = { id: row.id_config, hits: Number(row.hits), latest_report: iso(row.latest_report), settings: {} };
			msg.recent.push(config);
		}
		config.settings[row.setting] = row.value;
	}
	return out;
}

async function getKind(raw)
{
	const id = parsePositive(raw, 'kind id');
	const [rows] = await pool.query(`
		SELECT id_msg_kind, message, blocked
		FROM report_message_kinds
		WHERE id_msg_kind = :id`, { id });
	if (!rows.length)
		throw new NotFound('No such kind');
	return { id: rows[0].id_msg_kind, template: rows[0].message, blocked: !!rows[0].blocked };
}

function parseFilters(req)
{
	const args = {};
	if (req.query.status !== undefined)
		args.status = parseStatus(req.query.status);
	if (req.query.min_version !== undefined)
		args.min_value = parseVersion(req.query.min_version, 'min_version');
	// Inclusive, and dev builds after a release count as newer: max_version=v1.20.4 excludes v1.20.4-605-g...
	if (req.query.max_version !== undefined)
		args.max_value = parseVersion(req.query.max_version, 'max_version');
	if (req.query.since !== undefined)
	{
		const since = String(req.query.since);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || isNaN(Date.parse(since)))
			throw new BadRequest('since must be a date like 2026-11-01');
		args.since = since;
	}
	return args;
}

function filterQuery(req)
{
	const out = {};
	for (const k of ['status', 'min_version', 'max_version', 'since', 'text'])
		if (req.query[k] !== undefined)
			out[k] = String(req.query[k]);
	return out;
}

function describeFilters(args)
{
	return {
		status: args.status || 'new+reoccurring',
		min_version_value: args.min_value || null,
		max_version_value: args.max_value || null,
		since: args.since || null,
		text: args.text !== undefined ? args.text : null,
	};
}

function parseStatus(raw)
{
	const status = String(raw);
	if (!['new', 'resolved', 'reoccurring', 'any'].includes(status))
		throw new BadRequest('status must be new, resolved, reoccurring or any');
	return status;
}

function parseVersion(raw, name)
{
	let title = String(raw).trim();
	if (!title.startsWith('v'))
		title = 'v' + title;
	const value = lookups.calcVersionValue(title.substr(0, limits.VERSION_TITLE_LENGTH));
	if (!value)
		throw new BadRequest(name + ' must be a version like v1.20.4');
	return value;
}

function parsePositive(raw, name, max)
{
	if (raw === undefined || raw === '')
		return 0;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0 || (max && n > max))
		throw new BadRequest(name + ' must be a whole number' + (max ? ' from 1 to ' + max : ' above 0'));
	return n;
}

function makeUrl(path, params)
{
	const parts = [];
	for (const k in params)
		if (params[k] !== undefined && params[k] !== null && params[k] !== '')
			parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
	return path + (parts.length ? '?' + parts.join('&') : '');
}

function iso(date)
{
	if (!date || isNaN(date.getTime()))
		return null;
	return date.toISOString();
}
