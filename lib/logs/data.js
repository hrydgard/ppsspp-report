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
	case 'ignored':
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
	if (args.fixed_value !== undefined)
	{
		clauses.push('m.resolved_version_value = :fixed_value');
		queryArgs.fixed_value = args.fixed_value;
	}
	// Lists that aren't of one kind leave out blocked kinds (known noise stored before the block).
	const notBlocked = args.id_msg_kind === undefined ? kinds.notBlockedClause('m.id_msg_kind') : null;
	if (notBlocked)
		clauses.push(notBlocked);
	if (args.id_msg_kind === undefined && args.id_game === undefined)
		return null;
	if (args.version !== undefined || args.min_value !== undefined || args.max_value !== undefined || args.since !== undefined ||
		args.id_platform !== undefined || args.id_cpu !== undefined || args.id_gpu !== undefined)
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
// Bounded by estimated size (JS strings are 2 bytes per char; a text can be 4096 chars), oldest entries go first.
const GROUPED_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const groupedCache = new Map();
let groupedCacheBytes = 0;

function groupedCacheDelete(key)
{
	const entry = groupedCache.get(key);
	if (entry)
	{
		groupedCacheBytes -= entry.bytes;
		groupedCache.delete(key);
	}
}

module.exports.GROUPED_PAGE_SIZE = GROUPED_PAGE_SIZE;

module.exports.getGroupedKind = async function (args)
{
	const key = JSON.stringify([args.id_msg_kind, args.status || '', args.page, args.min_value || 0, args.max_value || 0, args.since || '',
		args.fixed_value || 0]);
	const cached = groupedCache.get(key);
	if (cached && cached.expires > Date.now())
		return cached.value;
	groupedCacheDelete(key);

	const status = statusClause(args.status);
	const where = 'm.id_msg_kind = :id_msg_kind' + (status ? ' AND ' + status : '') +
		(args.fixed_value !== undefined ? ' AND m.resolved_version_value = :fixed_value' : '');
	const queryArgs = {
		id_msg_kind: args.id_msg_kind,
		min_value: args.min_value || 0,
		max_value: args.max_value || 0,
		since: args.since || null,
		fixed_value: args.fixed_value,
		limit: GROUPED_PAGE_SIZE + 1,
		offset: (args.page - 1) * GROUPED_PAGE_SIZE,
	};
	// With a version range or date, only those reports count, so texts never seen there drop out.
	// versions is always joined, for latest_version (highest version value that reported the text).
	const versionJoin = 'INNER JOIN versions AS v USING (id_version)';
	const versionWhere = (args.min_value ? 'v.value >= :min_value AND ' : '') + (args.max_value ? 'v.value <= :max_value AND ' : '') +
		(args.since ? 'mv.latest_report >= :since AND ' : '');

	const template = await pool.executeGrab(`
		SELECT message
		FROM report_message_kinds
		WHERE id_msg_kind = :id_msg_kind`, queryArgs);

	// Grouped by the 20-byte hash, not the text: the (id_msg_kind, status, formatted_hash, id_game) index covers the
	// messages side, so no message rows are read.  The texts are fetched afterwards for the rows shown.
	const [groups] = await pool.query(`
		SELECT m.formatted_hash, MIN(m.id_msg) AS id_msg, COUNT(DISTINCT m.id_msg) AS messages, COUNT(DISTINCT m.id_game) AS games,
			SUM(mv.hits) AS hits, MAX(mv.latest_report) AS latest_report,
			SUBSTRING_INDEX(MAX(CONCAT(LPAD(v.value, 10, '0'), '|', v.title)), '|', -1) AS latest_version
		FROM report_messages AS m
			INNER JOIN report_message_versions AS mv USING (id_msg)
			${versionJoin}
		WHERE ${versionWhere} ${where}
		GROUP BY m.formatted_hash
		ORDER BY hits DESC, latest_report DESC, id_msg DESC
		LIMIT :limit OFFSET :offset`, queryArgs);

	const shown = groups.slice(0, GROUPED_PAGE_SIZE);
	const texts = {};
	if (shown.length)
	{
		const [textRows] = await pool.query(`
			SELECT id_msg, formatted_message
			FROM report_messages
			WHERE id_msg IN (:ids)`, { ids: shown.map(g => g.id_msg) });
		for (const row of textRows)
			texts[row.id_msg] = row.formatted_message;
	}
	const rows = shown.map(g => Object.assign({ message: texts[g.id_msg] || '' }, g));

	const value = {
		template,
		rows,
		more: groups.length > GROUPED_PAGE_SIZE,
	};

	let bytes = 2 * String(template || '').length + 256;
	for (const row of value.rows)
		bytes += 2 * String(row.message).length + 200;

	// Crawlers walk every kind, page and version, so drop expired entries, then the oldest, to stay under the cap.
	const now = Date.now();
	for (const [k, v] of groupedCache)
		if (v.expires <= now)
			groupedCacheDelete(k);
	for (const k of groupedCache.keys())
	{
		if (groupedCacheBytes + bytes <= GROUPED_CACHE_MAX_BYTES)
			break;
		groupedCacheDelete(k);
	}
	groupedCache.set(key, { value, bytes, expires: now + GROUPED_CACHE_MS });
	groupedCacheBytes += bytes;
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
	if (args.id_msg_kind !== undefined)
	{
		// Through the temp table too: the (id_msg_kind, status, ...) index finds the newest ids of even a 131k-message kind
		// quickly, while joining all of them to versions and platforms first took up to 40s.
		tempClauses.push('m.id_msg_kind = :id_msg_kind');
		queryArgs.id_msg_kind = args.id_msg_kind;
	}
	if (args.fixed_value !== undefined)
	{
		clauses.push('m.resolved_version_value = :fixed_value');
		queryArgs.fixed_value = args.fixed_value;
	}
	if (args.text !== undefined)
	{
		// Exact formatted text (the grouped view links here).  The hash is in the (id_msg_kind, id_game, formatted_hash) key.
		clauses.push('m.formatted_hash = UNHEX(SHA1(:text)) AND m.formatted_message = :text');
		queryArgs.text = args.text;
	}
	// Version range and date: messages with a report from those versions (on or after that date).
	const versionRange = args.version === undefined && (args.min_value !== undefined || args.max_value !== undefined);
	if (versionRange || args.since !== undefined)
	{
		needsTempDistinct = true;
		if (args.version === undefined)
			tempJoins.push('INNER JOIN report_message_versions AS mv USING (id_msg)');
		if (versionRange)
			tempJoins.push('INNER JOIN versions AS v USING (id_version)');
		if (versionRange && args.min_value !== undefined)
		{
			tempClauses.push('v.value >= :min_value');
			queryArgs.min_value = args.min_value;
		}
		if (versionRange && args.max_value !== undefined)
		{
			tempClauses.push('v.value <= :max_value');
			queryArgs.max_value = args.max_value;
		}
		if (args.since !== undefined)
		{
			tempClauses.push('mv.latest_report >= :since');
			queryArgs.since = args.since;
		}
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

	// Single platform/CPU/GPU filter: order by that table's id_msg, so its (id, id_msg) index is read newest first.
	// (No DISTINCT needed then: that table has one row per message for a given id.)
	let tempOrder = 'm.id_msg';
	if (tempJoins.length == 1 && args.id_platform !== undefined)
		tempOrder = 'mp.id_msg';
	else if (tempJoins.length == 1 && args.id_cpu !== undefined)
		tempOrder = 'mc.id_msg';
	else if (tempJoins.length == 1 && args.id_gpu !== undefined)
		tempOrder = 'mg.id_msg';

	const needsMaxCheck = (clauses.length == 0 && tempClauses.length == 0) || (!args.status && (clauses.length + tempClauses.length) <= 1);

	// The status filter and the blocked-kind filter must apply before the temp table's LIMIT 300, or resolved/ignored messages
	// and blocked kinds use up the 300 and the page comes out short (or empty).
	const useTemp = !needsMaxCheck && tempClauses.length > 0;
	if (status && useTemp)
		tempClauses.push(status);
	// Lists that aren't of one kind leave out blocked kinds (known noise stored before the block).
	const notBlocked = args.id_msg_kind === undefined ? kinds.notBlockedClause('m.id_msg_kind') : null;
	if (notBlocked)
		(useTemp ? tempClauses : clauses).push(notBlocked);

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
				SELECT ${needsTempDistinct && tempOrder == 'm.id_msg' ? 'DISTINCT ' : ''}m.id_msg
				FROM report_messages AS m ${tempJoins.join(`
					`)}
				${makeWhere(tempClauses)}
				ORDER BY ${tempOrder} DESC
				LIMIT 300`, queryArgs);

			extraJoinSQL = 'INNER JOIN temp_messages USING (id_msg)';
		}

		// Per message: version, latest report and hits come from one LATERAL subquery over its versions.  Joining versions and
		// platforms directly multiplied the rows (319 versions x 7 platforms per message is common) before grouping them back.
		// The platform/CPU/GPU tooltips list the 10 most recent, plus how many more (some messages have 1,500+ GPUs).  The 10 ids are
		// picked before joining the name tables: gpus rows are ~5.6 KB (extension lists), and joining first read all 1,500 of them.
		// (Don't put comments with quotes inside the SQL: mysql2's named-placeholder parser takes ' as a string start.)
		const recentList = (table, alias, nameCol, idCol, argName) => `(
					SELECT CONCAT(GROUP_CONCAT(x.${nameCol} ORDER BY t.latest_report DESC SEPARATOR ', '),
						IF(MAX(t.total) > 10, CONCAT(' and ', MAX(t.total) - 10, ' more'), ''))
					FROM (
						SELECT ${alias}.${idCol}, ${alias}.latest_report, COUNT(*) OVER () AS total
						FROM ${table} AS ${alias}
						WHERE ${alias}.id_msg = m.id_msg${args[argName] !== undefined ? ` AND ${alias}.${idCol} = :${argName}` : ''}
						ORDER BY ${alias}.latest_report DESC
						LIMIT 10
					) AS t
						INNER JOIN ${alias === 'mp' ? 'platforms' : alias === 'mc' ? 'cpus' : 'gpus'} AS x USING (${idCol})
				)`;
		const [results] = await conn.query(`
			SELECT
				g.title, g.id_game, ver.version, ver.id_version,
				m.id_msg, m.id_msg_kind, m.formatted_message AS message,
				ver.latest_report, ver.hits,
				${recentList('report_message_platforms', 'mp', 'title', 'id_platform', 'id_platform')} AS platforms,
				${recentList('report_message_cpus', 'mc', 'summary', 'id_cpu', 'id_cpu')} AS cpus,
				${recentList('report_message_gpus', 'mg', 'nickname', 'id_gpu', 'id_gpu')} AS gpus,
				mk.message AS message_template
			FROM report_messages AS m
				${extraJoinSQL}
				INNER JOIN games AS g USING (id_game)
				INNER JOIN report_message_kinds AS mk USING (id_msg_kind)
				INNER JOIN LATERAL (
					SELECT MAX(v.title) AS version, MAX(mv.id_version) AS id_version,
						MAX(mv.latest_report) AS latest_report, SUM(mv.hits) AS hits
					FROM report_message_versions AS mv
						INNER JOIN versions AS v USING (id_version)
					WHERE mv.id_msg = m.id_msg
				) AS ver ON TRUE
			${makeWhere(['ver.latest_report IS NOT NULL'])}
			ORDER BY m.id_msg DESC
			LIMIT 100`, queryArgs);
		return results;
	}
	finally
	{
		conn.release();
	}
};

// Kinds reported at least once from args.min_value or newer.  Driven from the versions table, so recent versions are fast
// (v1.20.4: 0.3s) and old ones slow (v1.10: 20s), hence the time limit and the cache.
const KINDS_CACHE_MS = 10 * 60 * 1000;
const kindsCache = new Map();

async function getKindListSince(args)
{
	const status = statusClause(args.status);
	const key = JSON.stringify([args.status || '', args.min_value]);
	const cached = kindsCache.get(key);
	if (cached && cached.expires > Date.now())
		return cached.value;

	const [rows] = await pool.query(`
		SELECT /*+ MAX_EXECUTION_TIME(15000) */ mk.id_msg_kind, mk.message, mk.blocked, COUNT(t.id_game) AS games
		FROM report_message_kinds AS mk
			LEFT JOIN (
				SELECT DISTINCT m.id_msg_kind, m.id_game
				FROM versions AS v
					STRAIGHT_JOIN report_message_versions AS mv USING (id_version)
					STRAIGHT_JOIN report_messages AS m USING (id_msg)
				WHERE v.value >= :min_value${status ? ' AND ' + status : ''}
			) AS t USING (id_msg_kind)
		WHERE t.id_msg_kind IS NOT NULL OR mk.blocked = 1
		GROUP BY mk.id_msg_kind
		ORDER BY mk.blocked ASC, mk.id_msg_kind DESC
		LIMIT 2000`, { min_value: args.min_value });

	if (kindsCache.size >= 50)
		kindsCache.clear();
	kindsCache.set(key, { value: rows, expires: Date.now() + KINDS_CACHE_MS });
	return rows;
}

module.exports.getKindList = async function (args)
{
	if (args.min_value)
		return getKindListSince(args);

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
