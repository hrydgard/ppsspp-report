const mysql = require('mysql2');
const async = require('async');
const pool = require('../db');
const settings = require('../settings');
const limits = require('../limits');
const lookups = require('../lookups');
const kinds = require('../kinds');

module.exports.addMessage = async function (parameters)
{
	if (settings.isVersionBlocked(parameters.version))
		return null;

	// Reject older versions right away.  Just noise.
	if (settings.isVersionTooOld(parameters.version))
		return null;

	if (parameters.verify && parameters.verify != parameters.message + parameters.value)
	{
		console.log('Message failed verification');
		return null;
	}

	const invalid_game_id = String(parameters.game).length > 1 && String(parameters.game).substr(-1) === '_';
	const invalid_game_title = String(parameters.game_title).length === 0;
	if (invalid_game_id || invalid_game_title)
	{
		console.log('Rejected game', parameters.game);
		return null;
	}

	// Kinds marked as noise (tools/kind block) are dropped before anything else is looked up or stored.
	const id_msg_kind = await lookups.getMessageKindId(parameters.message);
	if (kinds.isBlocked(id_msg_kind))
		return null;

	return async.auto({
		id_version: lookups.getVersionId.bind(this, parameters.version),
		id_gpu: lookups.getGpuId.bind(this, parameters.gpu, parameters.gpu_full),
		id_cpu: lookups.getCpuId.bind(this, parameters.cpu),
		id_platform: lookups.getPlatformId.bind(this, parameters.platform),
		id_game: lookups.getGameId.bind(this, parameters.game, parameters.game_title, parameters.module_name, parameters.module_crc),
		id_msg_kind: async () => id_msg_kind,
		id_config: lookups.getConfigId.bind(this, parameters),

		id_msg: [
			'id_version', 'id_gpu', 'id_cpu', 'id_platform', 'id_game', 'id_config', 'id_msg_kind',
			async function (args)
			{
				args.formatted_message = parameters.value;
				return lookups.getMessageId(args);
			}
		],

		log_hits: [
			'id_msg',
			function (args, cb)
			{
				pool.execute(`
					CALL report_message_hit(:id_msg, :id_version, :id_gpu, :id_cpu, :id_platform, :id_config)`, args).then(() => cb(), cb);
			}
		]
	});
};

// The status filter used by all log lists: ?status=new|resolved|reoccurring|any, default unresolved (new + reoccurring).
function statusClause(status)
{
	switch (status)
	{
	case 'any':
		return null;
	case 'new':
	case 'resolved':
	case 'reoccurring':
		return "m.status = '" + status + "'";
	default:
		return "m.status IN ('new', 'reoccurring')";
	}
}

// Number of messages a kind or game list has in total (cheap: both are indexed).  null for other lists.
module.exports.countMessages = async function (args)
{
	const clauses = [];
	const queryArgs = {};
	const status = statusClause(args.status);
	if (status)
		clauses.push(status);
	if (args.id_msg_kind !== undefined)
	{
		clauses.push('m.id_msg_kind = :id_msg_kind');
		queryArgs.id_msg_kind = args.id_msg_kind;
	}
	if (args.id_game !== undefined)
	{
		clauses.push('m.id_game = :id_game');
		queryArgs.id_game = args.id_game;
	}
	if (args.text !== undefined)
	{
		clauses.push('m.formatted_hash = UNHEX(SHA1(:text)) AND m.formatted_message = :text');
		queryArgs.text = args.text;
	}
	if (args.id_msg_kind === undefined && args.id_game === undefined)
		return null;
	if (args.version !== undefined || args.id_platform !== undefined || args.id_cpu !== undefined || args.id_gpu !== undefined)
		return null;

	return pool.executeGrab(`
		SELECT COUNT(*)
		FROM report_messages AS m
		WHERE ${clauses.join(' AND ')}`, queryArgs);
};

// One kind's messages grouped by exact text: games, rows and hits per distinct text, most hits first.
// This takes seconds for the biggest kinds (131k messages), so results are cached for a while.
const GROUPED_PAGE_SIZE = 100;
const GROUPED_CACHE_MS = 10 * 60 * 1000;
const groupedCache = new Map();

module.exports.GROUPED_PAGE_SIZE = GROUPED_PAGE_SIZE;

module.exports.getGroupedKind = async function (args)
{
	const key = JSON.stringify([args.id_msg_kind, args.status || '', args.page]);
	const cached = groupedCache.get(key);
	if (cached && cached.expires > Date.now())
		return cached.value;

	const status = statusClause(args.status);
	const where = 'm.id_msg_kind = :id_msg_kind' + (status ? ' AND ' + status : '');
	const queryArgs = {
		id_msg_kind: args.id_msg_kind,
		limit: GROUPED_PAGE_SIZE + 1,
		offset: (args.page - 1) * GROUPED_PAGE_SIZE,
	};

	const template = await pool.executeGrab(`
		SELECT message
		FROM report_message_kinds
		WHERE id_msg_kind = :id_msg_kind`, queryArgs);

	const [rows] = await pool.query(`
		SELECT m.formatted_message AS message, COUNT(*) AS messages, COUNT(DISTINCT m.id_game) AS games,
			SUM(h.hits) AS hits, MAX(h.latest_report) AS latest_report
		FROM report_messages AS m
			INNER JOIN (
				SELECT id_msg, SUM(hits) AS hits, MAX(latest_report) AS latest_report
				FROM report_message_versions
				WHERE id_msg IN (SELECT id_msg FROM report_messages AS m WHERE ${where})
				GROUP BY id_msg
			) AS h USING (id_msg)
		WHERE ${where}
		GROUP BY m.formatted_hash, m.formatted_message
		ORDER BY hits DESC, latest_report DESC
		LIMIT :limit OFFSET :offset`, queryArgs);

	const value = {
		template,
		rows: rows.slice(0, GROUPED_PAGE_SIZE),
		more: rows.length > GROUPED_PAGE_SIZE,
	};

	// Keep the cache from growing without bound (crawlers walk every kind and page).
	if (groupedCache.size > 500)
	{
		for (const [k, v] of groupedCache)
			if (v.expires <= Date.now())
				groupedCache.delete(k);
		if (groupedCache.size > 500)
			groupedCache.clear();
	}
	groupedCache.set(key, { value, expires: Date.now() + GROUPED_CACHE_MS });
	return value;
};

module.exports.getRecentMessageList = async function (args)
{
	let tempClauses = [];
	let tempJoins = [];
	let needsTempDistinct = false;
	let clauses = [];
	let queryArgs = {};

	const status = statusClause(args.status);
	if (status)
		clauses.push(status);

	if (args.id_game !== undefined)
	{
		// Force a temp table, the index usage for this path is not great.
		// MySQL uses a temp table anyway, but not as well as we can.
		tempClauses.push('m.id_game = :id_game');
		queryArgs.id_game = args.id_game;
	}
	if (args.version !== undefined)
	{
		tempClauses.push('v.title = :version');
		queryArgs.version = args.version;
		needsTempDistinct = true;
		tempJoins.push('INNER JOIN report_message_versions AS mv USING (id_msg)');
		tempJoins.push('INNER JOIN versions AS v USING (id_version)');
	}
	if (args.id_msg_kind !== undefined) {
		clauses.push('m.id_msg_kind = :id_msg_kind');
		queryArgs.id_msg_kind = args.id_msg_kind;
	}
	if (args.text !== undefined)
	{
		// Exact formatted text (the grouped view links here).  The hash is in the (id_msg_kind, id_game, formatted_hash) key.
		clauses.push('m.formatted_hash = UNHEX(SHA1(:text)) AND m.formatted_message = :text');
		queryArgs.text = args.text;
	}
	if (args.id_platform !== undefined)
	{
		tempClauses.push('mp.id_platform = :id_platform');
		queryArgs.id_platform = args.id_platform;
		needsTempDistinct = true;
		tempJoins.push('INNER JOIN report_message_platforms AS mp USING (id_msg)');
	}
	if (args.id_cpu !== undefined)
	{
		tempClauses.push('mc.id_cpu = :id_cpu');
		queryArgs.id_cpu = args.id_cpu;
		needsTempDistinct = true;
		tempJoins.push('INNER JOIN report_message_cpus AS mc USING (id_msg)');
	}
	if (args.id_gpu !== undefined)
	{
		tempClauses.push('mg.id_gpu = :id_gpu');
		queryArgs.id_gpu = args.id_gpu;
		needsTempDistinct = true;
		tempJoins.push('INNER JOIN report_message_gpus AS mg USING (id_msg)');
	}

	const needsMaxCheck = (clauses.length == 0 && tempClauses.length == 0) || (!args.status && (clauses.length + tempClauses.length) <= 1);

	// Use a consistent connection for a temp table.
	const conn = await pool.getConnection();
	try
	{
		let extraJoinSQL = '';

		const makeWhere = function (additional)
		{
			let where = '';
			const all = clauses.concat(additional || []);
			if (all.length == 1)
				where = 'WHERE ' + all[0];
			else if (all.length > 1)
				where = 'WHERE ' + all.join(' AND ');
			return where;
		};

		// Paging: ?before=<id_msg> shows the next older page.
		if (args.before !== undefined)
		{
			queryArgs.before = args.before;
			(tempClauses.length && !needsMaxCheck ? tempClauses : clauses).push('m.id_msg < :before');
		}

		if (needsMaxCheck)
		{
			// TODO: Could simply cache this.
			const max_id_msg = args.before !== undefined ? args.before - 1 : await conn.executeGrab(`
				SELECT MAX(id_msg)
				FROM report_messages`, {});
			clauses.push('m.id_msg > :max_id_msg - 1000');
			queryArgs.max_id_msg = max_id_msg;
		}
		// The purpose of this is to reduce the set it's looking at for the other joins.
		else if (tempClauses.length)
		{
			// Gotta drop it first in case another page view left it hanging.
			await conn.execute(`
				DROP TEMPORARY TABLE IF EXISTS temp_messages`);
			await conn.execute(`
				CREATE TEMPORARY TABLE temp_messages (
					PRIMARY KEY (id_msg)
				)
				SELECT ${needsTempDistinct ? 'DISTINCT ' : ''}m.id_msg
				FROM report_messages AS m ${tempJoins.join(`
					`)}
				${makeWhere(tempClauses)}
				ORDER BY m.id_msg DESC
				LIMIT 300`, queryArgs);

			extraJoinSQL = 'INNER JOIN temp_messages USING (id_msg)';
		}

		const [results] = await conn.query(`
			SELECT
				g.title, g.id_game, MAX(v.title) AS version, MAX(v.id_version) AS id_version,
				m.id_msg, m.id_msg_kind, m.formatted_message AS message,
				MAX(mv.latest_report) AS latest_report,
				(
					-- A subquery: the joins below would count each version's hits once per platform.
					SELECT SUM(h.hits)
					FROM report_message_versions AS h
					WHERE h.id_msg = m.id_msg
				) AS hits,
				(
					SELECT GROUP_CONCAT(p.title SEPARATOR ', ')
					FROM platforms AS p
						INNER JOIN report_message_platforms AS mp USING (id_platform)
					WHERE mp.id_msg = m.id_msg${(args.id_platform !== undefined ? `
						AND mp.id_platform = :id_platform` : '')}
				) AS platforms,
				(
					SELECT GROUP_CONCAT(cpus.summary SEPARATOR ', ')
					FROM cpus
						INNER JOIN report_message_cpus AS mc USING (id_cpu)
					WHERE mc.id_msg = m.id_msg${(args.id_cpu !== undefined ? `
						AND mc.id_cpu = :id_cpu` : '')}
				) AS cpus,
				(
					SELECT GROUP_CONCAT(gpus.nickname SEPARATOR ', ')
					FROM gpus
						INNER JOIN report_message_gpus AS mg USING (id_gpu)
					WHERE mg.id_msg = m.id_msg${(args.id_gpu !== undefined ? `
						AND mg.id_gpu = :id_gpu` : '')}
				) AS gpus,
				mk.message AS message_template
			FROM report_messages AS m
				${extraJoinSQL}
				INNER JOIN games AS g USING (id_game)
				INNER JOIN report_message_kinds AS mk USING (id_msg_kind)
				INNER JOIN report_message_versions AS mv USING (id_msg)
				INNER JOIN versions AS v USING (id_version)
				INNER JOIN report_message_platforms AS mp USING (id_msg)
			${makeWhere()}
			GROUP BY m.id_msg
			ORDER BY m.id_msg DESC
			LIMIT 100`, queryArgs);
		return results;
	}
	finally
	{
		conn.release();
	}
};

module.exports.getKindList = async function (args)
{
	let clauses = [];

	switch (args.status)
	{
	case 'any':
		break;

	case 'new':
	case 'resolved':
	case 'reoccurring':
		clauses.push("m.status IN (:status)");
		break;

	default:
		clauses.push("m.status IN ('new', 'reoccurring')");
	}

	// Use a consistent connection for a temp table.
	const conn = await pool.getConnection();
	try
	{
		const makeWhere = function (additional)
		{
			let where = '';
			const all = clauses.concat(additional || []);
			if (all.length == 1)
				where = 'WHERE ' + all[0];
			else if (all.length > 1)
				where = 'WHERE ' + all.join(' AND ');
			return where;
		};

		// Gotta drop it first in case another page view left it hanging.
		await conn.execute(`
			DROP TEMPORARY TABLE IF EXISTS temp_messages`);
		await conn.execute(`
			CREATE TEMPORARY TABLE temp_messages
			SELECT DISTINCT m.id_msg_kind, m.id_game
			FROM report_messages AS m
			${makeWhere()}`, args);

		// Blocked kinds are always listed, even when none of their messages match the status filter.
		const [results] = await conn.query(`
			SELECT mk.id_msg_kind, mk.message, mk.blocked, COUNT(m.id_game) AS games
			FROM report_message_kinds AS mk
				LEFT JOIN temp_messages AS m USING (id_msg_kind)
			WHERE m.id_msg_kind IS NOT NULL OR mk.blocked = 1
			GROUP BY mk.id_msg_kind
			ORDER BY mk.blocked ASC, mk.id_msg_kind DESC
			LIMIT 2000`, null);
		return results;
	}
	finally
	{
		conn.release();
	}
};

function safe(s, def)
{
	if (typeof s == 'undefined')
		return typeof def == 'undefined' ? '' : def;
	return String(s);
}
