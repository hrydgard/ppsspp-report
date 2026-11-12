'use strict';

const pool = require('../db');
const kinds = require('../kinds');

// Individual message reports: every stored report of a message, with the metadata the counters don't keep (play time, fps,
// firmware, OS, device...).  Only the newest REPORTS_PER_MESSAGE per message are kept.
const REPORTS_PER_MESSAGE = 100;
module.exports.REPORTS_PER_MESSAGE = REPORTS_PER_MESSAGE;
module.exports.PAGE_SIZE = 100;

function str(v, len)
{
	if (v === undefined || v === null)
		return '';
	// The connection is utf8mb3: 4-byte characters (emoji) can't be sent, so they become '?'.
	return Array.from(String(v).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\u{10000}-\u{10FFFF}]/gu, '?').trim()).slice(0, len).join('');
}

function num(v)
{
	if (v === undefined || v === null || v === '')
		return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function int(v, min, max)
{
	const n = num(v);
	if (n === null || !Number.isInteger(n) || n < min || n > max)
		return null;
	return n;
}

function bool(v)
{
	if (v === 'true' || v === '1' || v === 1 || v === true)
		return 1;
	if (v === 'false' || v === '0' || v === 0 || v === false)
		return 0;
	return null;
}

module.exports.addReport = async function (ids, parameters)
{
	// ticks is a uint64: keep it as a digit string, Number would round it.
	const ticks = /^\d{1,20}$/.test(String(parameters.ticks)) && BigInt(parameters.ticks) <= 18446744073709551615n ? String(parameters.ticks) : null;
	const row = {
		id_msg: ids.id_msg,
		id_version: ids.id_version,
		id_platform: ids.id_platform,
		id_gpu: ids.id_gpu,
		id_cpu: ids.id_cpu,
		id_config: ids.id_config,
		ticks,
		seconds_played: num(parameters.seconds_played),
		fps: num(parameters.fps),
		vps: num(parameters.vps),
		savestate_used: bool(parameters.savestate_used),
		pixel_width: int(parameters.pixel_width, 0, 65535),
		pixel_height: int(parameters.pixel_height, 0, 65535),
		sdkver: int(parameters.sdkver, 0, 4294967295),
		module_ver: int(parameters.module_ver, -2147483648, 2147483647),
		firmware: str(parameters.firmware, 16),
		file_type: str(parameters.file_type, 24),
		disc_container: str(parameters.disc_container, 8),
		os: str(parameters.os, 24),
		os_build: str(parameters.os_build, 24),
		device_model: str(parameters.device_model, 48),
	};
	await pool.query(`
		INSERT INTO report_message_reports SET reported_at = NOW(), ?`, [row]);

	// Keep the newest REPORTS_PER_MESSAGE.  Both statements use the (id_msg, id_report) index.
	const [over] = await pool.query(`
		SELECT id_report
		FROM report_message_reports
		WHERE id_msg = ?
		ORDER BY id_report DESC
		LIMIT 1 OFFSET ?`, [ids.id_msg, REPORTS_PER_MESSAGE]);
	if (over.length)
	{
		await pool.query(`
			DELETE FROM report_message_reports
			WHERE id_msg = ? AND id_report <= ?`, [ids.id_msg, over[0].id_report]);
	}
};

// Names for the ids, and each config's non-default settings.
const SELECT_REPORT = `
	r.id_report, r.id_msg, r.reported_at, r.ticks, r.seconds_played, r.fps, r.vps, r.savestate_used, r.pixel_width, r.pixel_height,
	r.sdkver, r.module_ver, r.firmware, r.file_type, r.disc_container, r.os, r.os_build, r.device_model, r.id_config,
	r.id_version, v.title AS version, r.id_platform, p.title AS platform, r.id_gpu, gp.nickname AS gpu, gp.short_desc AS gpu_desc,
	r.id_cpu, c.summary AS cpu`;
const JOIN_NAMES = `
	LEFT JOIN versions AS v ON v.id_version = r.id_version
	LEFT JOIN platforms AS p ON p.id_platform = r.id_platform
	LEFT JOIN gpus AS gp ON gp.id_gpu = r.id_gpu
	LEFT JOIN cpus AS c ON c.id_cpu = r.id_cpu`;

async function addConfigs(rows)
{
	const ids = Array.from(new Set(rows.map(r => r.id_config))).filter(id => id > 0);
	const settings = {};
	if (ids.length)
	{
		const [cfg] = await pool.query(`
			SELECT cv.id_config, s.title AS setting, d.value
			FROM config_values AS cv
				INNER JOIN config_settings AS s USING (id_config_setting)
				INNER JOIN config_data AS d USING (id_config_data)
			WHERE cv.id_config IN (?)
			ORDER BY cv.id_config, s.title`, [ids]);
		for (const c of cfg)
			(settings[c.id_config] = settings[c.id_config] || {})[c.setting] = c.value;
	}
	for (const r of rows)
		r.settings = settings[r.id_config] || {};
	return rows;
}

// One message's reports, newest first.
module.exports.getMessageReports = async function (id_msg, before)
{
	const [rows] = await pool.query(`
		SELECT ${SELECT_REPORT}
		FROM report_message_reports AS r ${JOIN_NAMES}
		WHERE r.id_msg = ?${before ? ' AND r.id_report < ?' : ''}
		ORDER BY r.id_report DESC
		LIMIT ?`, before ? [id_msg, before, module.exports.PAGE_SIZE] : [id_msg, module.exports.PAGE_SIZE]);
	return addConfigs(rows);
};

// The newest reports of all messages, as they came in (hits on old messages too, unlike /logs).  Unless `all`, only reports of
// open messages (new/reoccurring) of kinds that aren't blocked, like the /logs lists.
module.exports.getRecentReports = async function (before, all)
{
	const where = [];
	const params = [];
	if (before)
	{
		where.push('r.id_report < ?');
		params.push(before);
	}
	if (!all)
	{
		where.push("om.status IN ('new', 'reoccurring')");
		const notBlocked = kinds.notBlockedClause('om.id_msg_kind');
		if (notBlocked)
			where.push(notBlocked);
	}
	params.push(module.exports.PAGE_SIZE);
	const [rows] = await pool.query(`
		SELECT ${SELECT_REPORT}, m.id_msg_kind, m.id_game, g.title, LEFT(m.formatted_message, 400) AS message, m.status
		FROM (
			SELECT r.*
			FROM report_message_reports AS r
				${all ? '' : 'INNER JOIN report_messages AS om ON om.id_msg = r.id_msg'}
			${where.length ? 'WHERE ' + where.join(' AND ') : ''}
			ORDER BY r.id_report DESC
			LIMIT ?
		) AS r
			INNER JOIN report_messages AS m ON m.id_msg = r.id_msg
			INNER JOIN games AS g ON g.id_game = m.id_game ${JOIN_NAMES}
		ORDER BY r.id_report DESC`, params);
	return addConfigs(rows);
};

// The message itself, for the detail page header.
module.exports.getMessage = async function (id_msg)
{
	const [rows] = await pool.query(`
		SELECT m.id_msg, m.id_msg_kind, m.id_game, g.title, m.formatted_message AS message, m.status, m.resolved_version,
			m.resolve_note, m.resolved_at, mk.message AS template, mk.blocked,
			(SELECT SUM(hits) FROM report_message_versions WHERE id_msg = m.id_msg) AS hits,
			(SELECT MIN(first_report) FROM report_message_versions WHERE id_msg = m.id_msg) AS first_report,
			(SELECT MAX(latest_report) FROM report_message_versions WHERE id_msg = m.id_msg) AS latest_report,
			(SELECT COUNT(*) FROM report_message_reports WHERE id_msg = m.id_msg) AS stored_reports
		FROM report_messages AS m
			INNER JOIN games AS g ON g.id_game = m.id_game
			INNER JOIN report_message_kinds AS mk ON mk.id_msg_kind = m.id_msg_kind
		WHERE m.id_msg = ?`, [id_msg]);
	return rows[0] || null;
};
