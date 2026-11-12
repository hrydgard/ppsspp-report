'use strict';

// Read-only JSON API over the same data as the /logs pages, meant for scripts and agents looking for bugs to fix.
// See API.md (and GET /api/v1, which describes itself).

const data = require('../logs/data');
const lookups = require('../lookups');
const limits = require('../limits');
const pool = require('../db');
const crypto = require('crypto');
const kinds = require('../kinds');
const reports = require('../logs/reports');
const stats = require('../stats');

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
	server.getSecure('/api/v1/messages/:id_msg/reports', api_message_reports);
	server.getSecure('/api/v1/reports', api_reports);
	server.getSecure('/api/v1/stats', api_stats);
	server.app.post('/api/v1/resolve', api_resolve);
	server.app.post('/api/v1/kinds/:id_msg_kind/block', api_block);
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
		status: 'new | resolved | reoccurring | ignored. resolved = fixed in a version; reported again (same kind, game and exact text) from that version or newer, it becomes reoccurring. ignored = won\'t fix; reopens like resolved only if ignored as of a version. Default filter: new + reoccurring. Use status=any for everything.',
		user_agent: 'Cloudflare blocks some default client User-Agents (e.g. Python-urllib gets 403); send your own, like ppsspp-report-agent/1.0.',
		text_truncated: 'Texts are cut at 4,096 characters when stored; long shader sources often are.',
		dropped: 'Reports from PPSSPP older than v1.19.0, and kinds marked blocked, are no longer stored.',
	},
	endpoints: {
		'GET /api/v1/kinds': 'All kinds that have messages matching status: id, template, blocked, games. Params: status, min_version (only kinds reported from that version or newer; games counted from those versions).',
		'GET /api/v1/kinds/:id': 'One kind: template, blocked, message count.',
		'GET /api/v1/kinds/:id/groups': 'Distinct texts of a kind with games, messages, hits, latest report; most hits first. Params: status, min_version, max_version, since, page.',
		'GET /api/v1/kinds/:id/messages': 'Full messages of a kind, newest first, with version/platform/GPU/CPU details. Params: status, min_version, max_version, since, text (exact), limit (max 100), before (cursor; use "next").',
		'GET /api/v1/messages/:id': 'One message with all details, including the PPSSPP settings (configs) it was reported with.',
		'GET /api/v1/messages/:id/reports': 'The individual reports of a message (stored since 2026-11-12, newest 100 per message), newest first: time, ' +
			'version, platform, GPU, CPU, seconds_played (emulated), ticks, fps, vps, savestate_used, resolution, firmware, file_type, disc_container, os, ' +
			'os_build, device_model, settings. Param: before (cursor; use "next").',
		'GET /api/v1/reports': 'The newest individual reports of all messages, as they came in (same fields, plus the message). Param: before.',
		'GET /api/v1/stats': 'Ingest counters: stored or dropped (and why) per hour, for messages and compat reports; versions = incoming reports per PPSSPP version (before dropping) over 1/7/30 days.',
		'POST /api/v1/resolve': 'Change message status (needs Authorization: Bearer <secret>). JSON: action (resolve | ignore | reopen), ' +
			'messages (list of ids, result per id) or kind (+ optional text, fixed_version) and/or gpu (messages reported only from that GPU), version (fixed-in; required for resolve, optional ' +
			'for ignore), note, dry_run, force. See API.md.',
		'POST /api/v1/kinds/:id/block': 'Block or unblock a kind (needs the secret). JSON: blocked (true/false).',
	},
	parameters: {
		status: 'new, resolved, reoccurring, ignored or any (default: new + reoccurring)',
		fixed_version: 'only messages resolved/ignored at exactly this version',
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
			latest_version: row.latest_version,
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

// POST /api/v1/resolve: change message status.  action resolve (fixed in a version), ignore (won't fix / pruned, optionally as of a
// version) or reopen (back to new).  Scope: a list of message ids (result per id), or a kind, optionally narrowed to one exact text
// and/or one fixed_version (counts only).  Messages already reported from the given version or newer are skipped unless force: the fix
// evidently didn't cover them.  create_report_message2 reopens resolved messages (and ignored ones with a version) as 'reoccurring'
// when reported from that version or newer.  Repeating a call is harmless (unchanged).
const MAX_BATCH = 1000;

const api_resolve = handler(async (req) =>
{
	checkSecret(req);
	const body = req.body || {};
	const action = body.action === undefined ? 'resolve' : String(body.action);
	if (!['resolve', 'ignore', 'reopen'].includes(action))
		throw new BadRequest('action must be resolve, ignore or reopen');
	const dry_run = isTrue(body.dry_run);
	const force = isTrue(body.force);

	let version = '', version_value = 0;
	if (action == 'resolve' && body.version === undefined)
		throw new BadRequest('version (the version the fix is in, e.g. v1.20.5 or v1.20.4-4634-g9f286ee) is required to resolve');
	if (action == 'reopen' && body.version !== undefined)
		throw new BadRequest('reopen takes no version');
	if (body.version !== undefined)
	{
		version_value = parseVersion(body.version, 'version');
		version = versionTitle(body.version);
	}
	const note = body.note === undefined ? '' : String(body.note);
	if (note.length > 1024)
		throw new BadRequest('note is limited to 1024 characters');

	const newStatus = { resolve: 'resolved', ignore: 'ignored', reopen: 'new' }[action];
	const done = { resolve: 'resolved', ignore: 'ignored', reopen: 'reopened' }[action];
	const setSql = action == 'reopen' ?
		"m.status = 'new', m.resolved_version_value = 0, m.resolved_version = '', m.resolve_note = :note, m.resolved_at = NULL" :
		'm.status = :new_status, m.resolved_version_value = :version_value, m.resolved_version = :version, m.resolve_note = :note, m.resolved_at = NOW()';
	const checkSeen = version_value > 0 && !force;
	const seenVersion = `(
		SELECT SUBSTRING_INDEX(MAX(CONCAT(LPAD(v.value, 10, '0'), '|', v.title)), '|', -1)
		FROM report_message_versions AS mv
			INNER JOIN versions AS v USING (id_version)
		WHERE mv.id_msg = m.id_msg
			AND v.value >= :version_value
	)`;
	const args = { new_status: newStatus, version_value, version, note };
	const summary = { action, version: version || null, version_value: version_value || null, note, dry_run, force };

	const hasIds = body.messages !== undefined || body.message !== undefined;
	if (hasIds)
	{
		if (body.kind !== undefined || body.text !== undefined || body.fixed_version !== undefined)
			throw new BadRequest('give messages (ids), or kind with optional text / fixed_version, not both');
		const raw = body.messages !== undefined ? body.messages : [body.message];
		const list = Array.isArray(raw) ? raw : String(raw).split(',');
		if (list.length == 0 || list.length > MAX_BATCH)
			throw new BadRequest('messages must be a list of 1 to ' + MAX_BATCH + ' message ids');
		const ids = Array.from(new Set(list.map(id => parsePositive(id, 'message id'))));
		args.ids = ids;

		const [rows] = await pool.query(`
			SELECT m.id_msg, m.id_msg_kind, m.status, m.resolved_version, m.resolved_version_value, m.resolve_note,
				${checkSeen ? seenVersion : 'NULL'} AS seen_version
			FROM report_messages AS m
			WHERE m.id_msg IN (:ids)`, args);
		const byId = new Map(rows.map(r => [r.id_msg, r]));

		const results = [];
		const change = [];
		for (const id of ids)
		{
			const m = byId.get(id);
			let result;
			if (!m)
				result = { id, result: 'not_found' };
			else
			{
				result = { id, kind: m.id_msg_kind, status_before: m.status };
				const same = m.status == newStatus && (action == 'reopen' ||
					(Number(m.resolved_version_value) == version_value && m.resolved_version == version && m.resolve_note == note));
				if (same)
					result.result = 'unchanged';
				else if (m.seen_version)
				{
					result.result = 'skipped_seen_in_version';
					result.seen_version = m.seen_version;
				}
				else
				{
					result.result = dry_run ? 'would_be_' + done : done;
					change.push(id);
				}
			}
			results.push(result);
		}
		if (!dry_run && change.length)
			await pool.query(`UPDATE report_messages AS m SET ${setSql} WHERE m.id_msg IN (:change)`, Object.assign({ change }, args));

		summary.counts = {};
		for (const r of results)
			summary.counts[r.result] = (summary.counts[r.result] || 0) + 1;
		summary.results = results;
		logWrite(req, summary, { results: undefined, ids: ids.length });
		return summary;
	}

	// Bulk: a whole kind, or one exact text of it, or the messages resolved at one fixed_version; and/or the messages reported
	// only from one GPU (all their GPUs match, ignoring unnamed ones), e.g. gpu "Mali-4" for Mali-400/450 across all kinds.
	if (body.kind === undefined && body.gpu === undefined)
		throw new BadRequest('give messages (ids), or kind and/or gpu');
	const kind = body.kind !== undefined ? await getKind(body.kind) : null;
	const clauses = [];
	if (kind)
	{
		clauses.push('m.id_msg_kind = :id_msg_kind');
		args.id_msg_kind = kind.id;
	}
	if (body.gpu !== undefined)
	{
		const gpu = String(body.gpu).trim();
		if (gpu.length < 3 || gpu.length > 96)
			throw new BadRequest('gpu must be 3 to 96 characters, matched case-insensitively as part of the GPU name');
		args.gpu_like = '%' + gpu.replace(/[\\%_]/g, c => '\\' + c) + '%';
		clauses.push(`m.id_msg IN (
			SELECT mg.id_msg
			FROM gpus AS g
				INNER JOIN report_message_gpus AS mg USING (id_gpu)
			WHERE g.nickname LIKE :gpu_like
		) AND NOT EXISTS (
			SELECT 1
			FROM report_message_gpus AS mg2
				INNER JOIN gpus AS g2 USING (id_gpu)
			WHERE mg2.id_msg = m.id_msg
				AND g2.nickname NOT LIKE :gpu_like
				AND g2.nickname NOT IN ('', '(unreported)')
		)`);
	}
	if (body.text !== undefined)
	{
		clauses.push('m.formatted_hash = UNHEX(SHA1(:text)) AND m.formatted_message = :text');
		args.text = String(body.text);
	}
	if (body.fixed_version !== undefined)
	{
		clauses.push('m.resolved_version_value = :fixed_value');
		args.fixed_value = parseVersion(body.fixed_version, 'fixed_version');
	}
	if (action == 'reopen')
	{
		// Reopening a whole kind would bring back every old resolution (kind 967 has 73k), so narrow it.
		if (body.text === undefined && body.fixed_version === undefined && body.gpu === undefined)
			throw new BadRequest('reopen of a kind needs text, fixed_version or gpu; for single messages pass messages: [ids]');
		clauses.push("m.status IN ('resolved', 'ignored')");
	}
	else
	{
		// Only open messages; already resolved/ignored ones keep their version and note (pass ids to change those).
		clauses.push("m.status IN ('new', 'reoccurring')");
	}

	const [byKind] = await pool.query(`
		SELECT /*+ MAX_EXECUTION_TIME(60000) */ m.id_msg_kind AS kind, COUNT(*) AS matching,
			${checkSeen ? `COALESCE(SUM(${seenVersion} IS NOT NULL), 0)` : '0'} AS seen
		FROM report_messages AS m
		WHERE ${clauses.join(' AND ')}
		GROUP BY m.id_msg_kind
		ORDER BY matching DESC`, args);
	const counts = { matching: 0, seen: 0 };
	for (const row of byKind)
	{
		counts.matching += Number(row.matching);
		counts.seen += Number(row.seen);
	}
	let changed = counts.matching - counts.seen;
	if (!dry_run && changed > 0)
	{
		const [result] = await pool.query(`
			UPDATE report_messages AS m
			SET ${setSql}
			WHERE ${clauses.join(' AND ')}${checkSeen ? ` AND ${seenVersion} IS NULL` : ''}`, args);
		changed = result.affectedRows;
	}
	Object.assign(summary, {
		scope: Object.assign({}, kind ? { kind: kind.id } : {}, body.gpu !== undefined ? { gpu: String(body.gpu).trim() } : {},
			args.text !== undefined ? { text: args.text } : {}, args.fixed_value !== undefined ? { fixed_version_value: args.fixed_value } : {}),
		matching_messages: counts.matching,
		skipped_seen_in_version: counts.seen,
		[dry_run ? 'would_be_' + done : done]: changed,
		by_kind: byKind.map(row => ({ kind: row.kind, matching: Number(row.matching), skipped_seen_in_version: Number(row.seen) })),
	});
	logWrite(req, summary, Object.assign({ by_kind: byKind.length + ' kinds' },
		args.text !== undefined ? { scope: Object.assign({}, summary.scope, { text: args.text.substr(0, 80) }) } : {}));
	return summary;
});

// POST /api/v1/kinds/:id/block {blocked: true|false}: block (drop new reports of) or unblock a kind, like tools/kind.
const api_block = handler(async (req) =>
{
	checkSecret(req);
	const kind = await getKind(req.params.id_msg_kind);
	const body = req.body || {};
	if (body.blocked === undefined)
		throw new BadRequest('blocked (true or false) is required');
	const blocked = isTrue(body.blocked);
	const [result] = await pool.query(`
		UPDATE report_message_kinds
		SET blocked = :blocked
		WHERE id_msg_kind = :id`, { blocked: blocked ? 1 : 0, id: kind.id });
	await kinds.refresh();
	const summary = { kind: kind.id, template: kind.template, blocked, changed: result.changedRows == 1 };
	logWrite(req, summary, { template: undefined });
	return summary;
});

function logWrite(req, summary, override)
{
	console.log(new Date().toISOString() + ' API ' + req.path + ' from ' + req.ip + ': ' + JSON.stringify(Object.assign({}, summary, override)));
}

function isTrue(v)
{
	return v === true || v === 1 || v === 'true' || v === '1';
}

// The version as given, normalized to start with v (stored for display; resolved_version_value is what's compared).
function versionTitle(raw)
{
	let title = String(raw).trim();
	if (!title.startsWith('v'))
		title = 'v' + title;
	return title.substr(0, limits.VERSION_TITLE_LENGTH);
}

function describeReport(r)
{
	const out = {
		id: r.id_report,
		message_id: r.id_msg,
		reported_at: r.reported_at ? r.reported_at.toISOString() : null,
		version: r.version,
		platform: r.platform,
		gpu: r.gpu,
		gpu_desc: r.gpu_desc,
		cpu: r.cpu,
		seconds_played: r.seconds_played,
		ticks: r.ticks === null ? null : String(r.ticks),
		fps: r.fps,
		vps: r.vps,
		savestate_used: r.savestate_used === null ? null : !!r.savestate_used,
		pixel_width: r.pixel_width,
		pixel_height: r.pixel_height,
		sdkver: r.sdkver === null ? null : '0x' + Number(r.sdkver).toString(16),
		module_ver: r.module_ver,
		firmware: r.firmware,
		file_type: r.file_type,
		disc_container: r.disc_container,
		os: r.os,
		os_build: r.os_build,
		device_model: r.device_model,
		settings: r.settings,
	};
	if (r.id_msg_kind !== undefined)
	{
		out.kind = r.id_msg_kind;
		out.game = { id: r.id_game, title: r.title };
		out.text_start = r.message;
		out.status = r.status;
	}
	return out;
}

function reportsCursor(req, rows)
{
	const before = parseInt(String(req.query.before || ''), 10);
	if (req.query.before !== undefined && !(before > 0))
		throw new BadRequest('before must be a report id');
	return before > 0 ? before : 0;
}

function nextLink(req, rows)
{
	if (rows.length < reports.PAGE_SIZE)
		return null;
	return req.path + '?before=' + rows[rows.length - 1].id_report;
}

const api_message_reports = handler(async (req) =>
{
	const id_msg = parseInt(req.params.id_msg, 10);
	if (!(id_msg > 0))
		throw new BadRequest('Bad message id');
	const before = reportsCursor(req);
	const [msg, rows] = await Promise.all([reports.getMessage(id_msg), reports.getMessageReports(id_msg, before)]);
	if (!msg)
		throw new NotFound('No such message');
	return {
		message_id: id_msg,
		kind: msg.id_msg_kind,
		stored_reports: Number(msg.stored_reports),
		hits: Number(msg.hits),
		reports: rows.map(describeReport),
		next: nextLink(req, rows),
	};
});

const api_reports = handler(async (req) =>
{
	const rows = await reports.getRecentReports(reportsCursor(req));
	return { reports: rows.map(describeReport), next: nextLink(req, rows) };
});

const api_stats = handler(async () =>
{
	const [{ totals, hours }, versions] = await Promise.all([stats.getSummary(), stats.getVersionSummary()]);
	return {
		outcomes: stats.OUTCOMES,
		totals,
		versions,
		hours: hours.map(h => Object.assign({}, h, { hour: h.hour.toISOString() })),
	};
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
				m.resolved_version, m.resolve_note, m.resolved_at, m.formatted_message, mk.message AS template
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
					MAX(mv.latest_report) OVER (PARTITION BY mv.id_msg) AS latest_ever,
					FIRST_VALUE(v.title) OVER (PARTITION BY mv.id_msg ORDER BY v.value DESC, mv.latest_report DESC) AS newest_version
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
			fixed_version: m.resolved_version || null,
			fixed_version_value: m.resolved_version_value || null,
			note: m.resolve_note || null,
			resolved_at: iso(m.resolved_at),
			latest_version: vs.length ? vs[0].newest_version : null,
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
	if (req.query.fixed_version !== undefined)
		args.fixed_value = parseVersion(req.query.fixed_version, 'fixed_version');
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
	for (const k of ['status', 'min_version', 'max_version', 'since', 'fixed_version', 'text'])
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
		fixed_version_value: args.fixed_value || null,
		text: args.text !== undefined ? args.text : null,
	};
}

function parseStatus(raw)
{
	const status = String(raw);
	if (!['new', 'resolved', 'reoccurring', 'ignored', 'any'].includes(status))
		throw new BadRequest('status must be new, resolved, reoccurring, ignored or any');
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
