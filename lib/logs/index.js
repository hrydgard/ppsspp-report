const data = require('./data');
const reports = require('./reports');
const stats = require('../stats');
const settings = require('../settings');
const lookups = require('../lookups');
const Plates = require('plates');
const multer = require('multer');

let g_server;

module.exports.addRoutes = function (server)
{
	g_server = server;
	server.app.post('/report/message', report_message);

	server.app.get('/temp/recent', temp_recent);
	server.app.get('/temp/recent*', temp_recent);

	server.getSecure('/logs', logs);
	server.getSecure('/logs/version/:version', logs_version);
	server.getSecure('/logs/game/:id_game', logs_game);
	server.getSecure('/logs/kind/:id_msg_kind', logs_kind);
	server.getSecure('/logs/kind/:id_msg_kind/grouped', logs_kind_grouped);
	server.getSecure('/logs/platform/:id_platform', logs_platform);
	server.getSecure('/logs/cpu/:id_cpu', logs_cpu);
	server.getSecure('/logs/gpu/:id_gpu', logs_gpu);

	server.getSecure('/logs/kinds', logs_kind_index);
	server.getSecure('/logs/message/:id_msg', logs_message);
	server.getSecure('/logs/all', logs_all);
	server.getSecure('/stats', stats_page);
};

function report_message(req, res)
{
	const upload = multer().fields([]);
	upload(req, res, async function (err)
	{
		if (err)
		{
			stats.count('message', 'bad_upload');
			console.log(err);
			return;
		}
		try
		{
			stats.countVersion('message', (req.body || {}).version);
			stats.count('message', await data.addMessage(req.body || {}));
		}
		catch (err)
		{
			stats.count('message', 'error');
			console.log(err);
		}
	});

	res.setHeader('Content-Type', 'text/plain; charset=utf-8');
	res.end('1');
}

function temp_recent(req, res)
{
	let dest = '/logs' + (req.params[0] ? req.params[0] : '');
	if (process.env.OPENSHIFT_EXTERNAL_URL)
		dest = process.env.OPENSHIFT_EXTERNAL_URL + dest;
	res.redirect(301, dest);
	res.end();
}

async function logs_common(args, req, res)
{
	try
	{
		res.setHeader('Content-Type', 'text/html; charset=utf-8');

		if ('status' in req.query)
			args.status = String(req.query.status);
		const before = parseInt(String(req.query.before || ''), 10);
		if (before > 0)
			args.before = before;
		if (args.id_msg_kind !== undefined && typeof req.query.text == 'string' && req.query.text.length <= 4096)
			args.text = req.query.text;
		const minVersion = parseMinVersion(req.query.min_version);
		if (minVersion.value)
			args.min_value = minVersion.value;

		const [messages_raw, total] = await Promise.all([
			data.getRecentMessageList(args),
			args.before === undefined ? data.countMessages(args) : null,
		]);
		let messages = messages_raw;
		let map = Plates.Map();
		map.class('messages').to('messages');
		map.where('title').is('id_game').insert('id_game');
		map.where('title').is('platform-info').insert('platform_info');
		map.class('title-text').to('title');
		map.class('title-text').use('title_uri').as('href');
		map.class('version-text').to('version');
		map.class('version-text').use('version_uri').as('href');
		map.class('latest_report-text').to('latest_report_short');
		map.where('title').is('latest_report').insert('latest_report');
		map.class('message-text').to('message');
		map.class('message-text').use('message_uri').as('href');
		map.class('hits-text').to('hits_text');
		map.class('hits-text').use('hits_uri').as('href');

		map.tag('title').insert('title');
		map.class('page-title').use('page-title');

		let title = '';
		messages = messages.map(function (row)
		{
			row.latest_report_short = row.latest_report.toISOString().replace(/T.*$/, '');
			row.latest_report = row.latest_report.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
			row.title_uri = '/logs/game/' + encodeURIComponent(row.id_game);
			row.version_uri = '/logs/version/' + encodeURIComponent(row.version);
			row.message_uri = '/logs/kind/' + encodeURIComponent(row.id_msg_kind);
			row.platform_info = row.platforms + "\n" + row.gpus + "\n" + row.cpus;
			row.hits_text = formatNumber(row.hits);
			row.hits_uri = '/logs/message/' + encodeURIComponent(row.id_msg);

			for (let k in row)
			{
				if (typeof row[k] == 'string')
					row[k] = escape_html(row[k]);
			}

			if (title == '')
			{
				if (args.id_game)
					title = row.title;
				else if (args.id_msg_kind)
					title = row.message_template;
				else if (args.version)
					title = row.version;
				else if (args.id_platform)
					title = row.platforms;
				else if (args.id_cpu)
					title = row.cpus;
				else if (args.id_gpu)
					title = row.gpus;
			}

			return row;
		});

		const page_title = title == '' ? 'Recent logs' : 'Recent logs - ' + title;

		// "Showing ..." line, the grouped/exact-text links for a kind, and Newest / Older paging.
		const basePath = req.path;
		const keep = {};
		if (args.status)
			keep.status = args.status;
		if (args.text !== undefined)
			keep.text = args.text;
		if (args.min_value)
			keep.min_version = minVersion.title;
		let summary = '';
		if (total !== null && total !== undefined && total <= messages.length)
			summary = 'Showing all ' + formatNumber(total) + (total == 1 ? ' message.' : ' messages.');
		else if (total !== null && total !== undefined)
			summary = 'Showing the ' + formatNumber(messages.length) + ' newest of ' + formatNumber(total) + ' messages.';
		else if (args.before !== undefined)
			summary = 'Showing ' + formatNumber(messages.length) + ' older messages.';
		else
			summary = 'Showing the ' + formatNumber(messages.length) + ' newest messages.';
		summary += ' One row per game and distinct message text; Hits counts every report of it.';
		if (args.min_value && args.version === undefined)
			summary += ' Only messages also reported from ' + escape_html(minVersion.title) + ' or newer (Version and Hits still cover all versions).';
		else if (minVersion.invalid)
			summary += ' Ignored min_version: not a version like v1.20.4.';
		if (args.id_msg_kind !== undefined)
		{
			const kindPath = '/logs/kind/' + encodeURIComponent(args.id_msg_kind);
			if (args.text !== undefined)
				summary += ' Only messages with exactly this text: <code>' + escape_html(args.text) + '</code>. <a href="' +
					makeLink(kindPath, { status: args.status, min_version: keep.min_version }) + '">Show all of this kind</a>.';
			summary += ' <a href="' + makeLink(kindPath + '/grouped', { status: args.status, min_version: keep.min_version }) + '">Group by message text</a>';
		}

		let paging = [];
		if (args.before !== undefined)
			paging.push('<a href="' + makeLink(basePath, keep) + '">&laquo; Newest</a>');
		if (messages_raw.length >= 100)
			paging.push('<a href="' + makeLink(basePath, Object.assign({}, keep, { before: messages_raw[messages_raw.length - 1].id_msg })) + '">Older &raquo;</a>');
		const html_title = title == '' ? '' : title + ' - ';
		// Always wrapped in a tag: Plates' append() treats a string without HTML as a file path to read.
		map.class('list-summary').append('<span>' + summary + '</span>');
		map.class('paging-holder').append('<span>' + paging.join(' &nbsp; ') + '</span>');
		res.end(Plates.bind(String(g_server.getStatic('./pages/logs.html')), {
			messages,
			'title': html_title,
			'page-title': page_title,
		}, map));
	}
	catch (err)
	{
		console.error(err);
		res.status(500).end(String(g_server.getStatic('./pages/errors/500.html')));
	}
}

function logs(req, res)
{
	logs_common({}, req, res);
}

function logs_version(req, res)
{
	logs_common({version: req.params.version}, req, res);
}

function logs_game(req, res)
{
	logs_common({id_game: req.params.id_game}, req, res);
}

function logs_kind(req, res)
{
	logs_common({id_msg_kind: req.params.id_msg_kind}, req, res);
}

function logs_platform(req, res)
{
	logs_common({id_platform: req.params.id_platform}, req, res);
}

function logs_cpu(req, res)
{
	logs_common({id_cpu: req.params.id_cpu}, req, res);
}

function logs_gpu(req, res)
{
	logs_common({id_gpu: req.params.id_gpu}, req, res);
}

async function logs_kind_index(req, res)
{
	try
	{
		res.setHeader('Content-Type', 'text/html; charset=utf-8');

		let args = {};
		if ('status' in req.query)
			args.status = String(req.query.status);
		const minVersion = parseMinVersion(req.query.min_version);
		if (minVersion.value)
			args.min_value = minVersion.value;
		const min_version = minVersion.value ? minVersion.title : undefined;

		let note = '';
		let kinds;
		try
		{
			kinds = await data.getKindList(args);
		}
		catch (err)
		{
			// MAX_EXECUTION_TIME hit: old versions mean scanning most of the reports.
			if (err.errno !== 3024)
				throw err;
			kinds = [];
			note = 'Listing kinds from ' + escape_html(min_version) + ' on took too long. Try a newer version (v1.19 or later).';
		}
		if (min_version && !note)
			note = 'Only kinds reported at least once from ' + escape_html(min_version) + ' or newer (plus blocked kinds); # of games counts ' +
				'games that reported it from those versions.';
		else if (minVersion.invalid)
			note = 'Ignored the version filter: not a version like v1.20.4.';
		let map = Plates.Map();
		map.class('kinds').to('kinds');
		map.class('message-text').to('message');
		map.class('message-text').use('message_uri').as('href');
		map.class('games-text').to('games');
		map.class('kind-id').to('id_msg_kind');
		map.class('kind-id').use('message_uri').as('href');
		map.class('blocked-text').to('blocked_text');
		map.class('status-link').use('status_uri').as('href');
		map.class('status-link').to('status_text');

		kinds = kinds.map(function (src)
		{
			const row = Object.assign({}, src);  // rows may come from a cache
			row.message_uri = makeLink('/logs/kind/' + encodeURIComponent(row.id_msg_kind), { min_version });
			row.id_msg_kind = String(row.id_msg_kind);
			row.games = String(row.games);
			row.blocked_text = row.blocked ? 'blocked' : '';

			for (let k in row)
			{
				if (typeof row[k] == 'string' && k != 'message_uri')
					row[k] = escape_html(row[k]);
			}

			return row;
		});

		const showingAll = args.status === 'any';
		// makeLink() escapes, and Plates inserts attribute values as given.
		const status_uri = makeLink('/logs/kinds', { status: showingAll ? undefined : 'any', min_version });
		const status_text = showingAll ? 'Show only kinds with unresolved messages' : 'Show all kinds, including fully resolved ones';

		const filterForm = '<form method="get" action="/logs/kinds" class="version-filter">' +
			'Only kinds reported from version <input type="text" name="min_version" placeholder="v1.20.4" size="12" value="' +
			escape_html(min_version || '') + '"> or newer ' +
			(args.status ? '<input type="hidden" name="status" value="' + escape_html(args.status) + '">' : '') +
			'<button type="submit">Apply</button>' +
			(min_version ? ' <a href="' + makeLink('/logs/kinds', { status: args.status }) + '">All versions</a>' : '') + '</form>' +
			(note ? '<p>' + note + '</p>' : '');
		map.class('filter-holder').append('<span>' + filterForm + '</span>');
		res.end(Plates.bind(String(g_server.getStatic('./pages/logs_kinds.html')), { kinds, status_uri, status_text }, map));
	}
	catch (err)
	{
		console.error(err);
		res.status(500).end(String(g_server.getStatic('./pages/errors/500.html')));
	}
}

async function logs_kind_grouped(req, res)
{
	try
	{
		res.setHeader('Content-Type', 'text/html; charset=utf-8');

		const id_msg_kind = parseInt(req.params.id_msg_kind, 10);
		if (!(id_msg_kind > 0))
		{
			res.status(404).end(String(g_server.getStatic('./pages/errors/404.html')));
			return;
		}
		const args = { id_msg_kind, page: Math.max(1, Math.min(1000, parseInt(String(req.query.page || '1'), 10) || 1)) };
		if ('status' in req.query)
			args.status = String(req.query.status);
		const minVersion = parseMinVersion(req.query.min_version);
		if (minVersion.value)
			args.min_value = minVersion.value;
		const min_version = minVersion.value ? minVersion.title : undefined;

		const result = await data.getGroupedKind(args);
		if (result.template === false || result.template === null || result.template === undefined)
		{
			res.status(404).end(String(g_server.getStatic('./pages/errors/404.html')));
			return;
		}

		const kindPath = '/logs/kind/' + id_msg_kind;
		const rows = result.rows.map(function (row)
		{
			return {
				message: escape_html(String(row.message)),
				message_uri: makeLink(kindPath, { status: args.status, min_version, text: String(row.message) }),
				games: formatNumber(row.games),
				messages: formatNumber(row.messages),
				hits: formatNumber(row.hits),
				latest_report: row.latest_report ? row.latest_report.toISOString().replace(/T.*$/, '') : '',
			};
		});

		const first = (args.page - 1) * data.GROUPED_PAGE_SIZE + 1;
		const versionNote = min_version ? ' Counting only reports from ' + escape_html(min_version) + ' or newer.' :
			(minVersion.invalid ? ' Ignored the version filter: not a version like v1.20.4.' : '');
		let summary = (rows.length == 0 ? 'No messages.' + versionNote + ' ' :
			'Distinct message texts ' + formatNumber(first) + '-' + formatNumber(first + rows.length - 1) + ', most hits first.' + versionNote + ' ' +
			'Games and Rows count where each text was seen; click a text for its games. Refreshed every 10 minutes. ') +
			'<a href="' + makeLink(kindPath, { status: args.status, min_version }) + '">Back to the list by game</a>';

		// GET form for the version filter (keeps the status filter).
		const filterForm = '<form method="get" action="' + escape_html(req.path) + '" class="version-filter">' +
			'Only count reports from version <input type="text" name="min_version" placeholder="v1.20.4" size="12" value="' +
			escape_html(min_version || '') + '"> or newer ' +
			(args.status ? '<input type="hidden" name="status" value="' + escape_html(args.status) + '">' : '') +
			'<button type="submit">Apply</button>' +
			(min_version ? ' <a href="' + makeLink(req.path, { status: args.status }) + '">All versions</a>' : '') + '</form>';

		let paging = [];
		if (args.page > 1)
			paging.push('<a href="' + makeLink(req.path, { status: args.status, min_version, page: args.page - 1 }) + '">&laquo; Previous</a>');
		if (result.more)
			paging.push('<a href="' + makeLink(req.path, { status: args.status, min_version, page: args.page + 1 }) + '">Next &raquo;</a>');

		const map = Plates.Map();
		map.class('groups').to('groups');
		map.class('message-text').to('message');
		map.class('message-text').use('message_uri').as('href');
		map.class('games-text').to('games');
		map.class('messages-text').to('messages');
		map.class('hits-text').to('hits');
		map.class('latest_report-text').to('latest_report');
		map.tag('title').insert('title');
		map.class('page-title').use('page-title');

		// Always wrapped in a tag: Plates' append() treats a string without HTML as a file path to read.
		map.class('list-summary').append('<span>' + summary + '</span>');
		map.class('filter-holder').append('<span>' + filterForm + '</span>');
		map.class('paging-holder').append('<span>' + paging.join(' &nbsp; ') + '</span>');
		const template = escape_html(String(result.template));
		res.end(Plates.bind(String(g_server.getStatic('./pages/logs_grouped.html')), {
			groups: rows,
			title: template + ' - ',
			'page-title': 'Messages by text - ' + template,
		}, map));
	}
	catch (err)
	{
		console.error(err);
		res.status(500).end(String(g_server.getStatic('./pages/errors/500.html')));
	}
}

// A page from pages/logs_page.html: title plus HTML built here (all values escaped where they're put together).
function renderPage(res, title, html)
{
	const map = Plates.Map();
	map.tag('title').insert('title');
	map.class('page-title').use('page-title');
	// Always wrapped in a tag: Plates' append() treats a string without HTML as a file path to read.
	map.class('content-holder').append('<div>' + html + '</div>');
	res.end(Plates.bind(String(g_server.getStatic('./pages/logs_page.html')), { title: title + ' - ', 'page-title': title }, map));
}

function fail(res, err)
{
	console.error(err);
	res.status(500).end(String(g_server.getStatic('./pages/errors/500.html')));
}

function notFound(res)
{
	res.status(404).end(String(g_server.getStatic('./pages/errors/404.html')));
}

function e(v)
{
	return v === null || v === undefined ? '' : escape_html(String(v));
}

function fmtTime(d)
{
	return d ? d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : '';
}

// Emulated play time: 3725.4 -> "1h 02m 05s".
// Older builds only send ticks (emulated CPU cycles); at the PSP's default 222 MHz that gives an estimate of the play time.
const TICKS_PER_SECOND = 222000000;

function fmtPlayed(sec)
{
	if (sec === null || sec === undefined)
		return '';
	sec = Number(sec);
	if (sec < 60)
		return sec.toFixed(1) + 's';
	const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec) % 60;
	const pad = n => String(n).padStart(2, '0');
	return (h ? h + 'h ' + pad(m) + 'm ' : m + 'm ') + pad(s) + 's';
}

function cell(text, title, cls)
{
	return '<td' + (cls ? ' class="' + cls + '"' : '') + (title ? ' title="' + e(title) + '"' : '') + '>' + text + '</td>';
}

function lines(parts)
{
	return parts.filter(p => p !== '' && p !== null && p !== undefined).map(e).join('<br>');
}

// The cells both report tables share.
function reportCells(r)
{
	const settings = Object.keys(r.settings).map(k => k + ' = ' + r.settings[k]).join('\n');
	const nSettings = Object.keys(r.settings).length;
	const played = r.seconds_played !== null ? fmtPlayed(r.seconds_played) : '';
	const playedTitle = (r.seconds_played !== null ? 'Emulated time since boot: ' + Number(r.seconds_played).toFixed(2) + ' s' : 'No seconds_played (older build)') +
		(r.ticks !== null ? '\nCPU ticks: ' + r.ticks + ' (~' + (Number(r.ticks) / TICKS_PER_SECOND).toFixed(1) + ' s at 222 MHz)' : '');
	return [
		cell(lines([r.platform, r.os, r.os_build]), '', 'system'),
		cell(lines([r.device_model]), '', 'device'),
		cell(lines([r.gpu]), r.gpu_desc, 'gpu'),
		cell(lines([r.cpu]), '', 'cpu'),
		cell(played || (r.ticks !== null ? '<span class="muted">est. (ticks): ' + e(fmtPlayed(Number(r.ticks) / TICKS_PER_SECOND)) + '</span>' : ''), playedTitle, 'played'),
		cell(lines([
			r.fps !== null || r.vps !== null ? (r.fps !== null ? Number(r.fps).toFixed(1) : '?') + ' / ' + (r.vps !== null ? Number(r.vps).toFixed(1) : '?') : '',
			r.pixel_width ? r.pixel_width + 'x' + r.pixel_height : '',
		]), 'FPS / VPS, then render resolution', 'perf'),
		cell(r.savestate_used === null ? '' : (r.savestate_used ? 'yes' : 'no'), 'A savestate was loaded this session', 'savestate'),
		cell(lines([r.firmware, [r.file_type, r.disc_container].filter(Boolean).join(' / ')]),
			'Firmware, then file type / disc container' + (r.sdkver !== null ? '\nSDK version: 0x' + Number(r.sdkver).toString(16) : '') +
			(r.module_ver !== null ? '\nModule version: ' + r.module_ver : ''), 'file'),
		cell(nSettings ? nSettings + ' changed' : 'defaults', settings || 'All reported settings at their defaults', 'settings'),
	];
}

const REPORT_HEADERS = '<th>System</th><th>Device</th><th>GPU</th><th>CPU</th><th title="Emulated time since the game booted">Played</th>' +
	'<th title="FPS / VPS, render resolution">Perf</th><th title="Savestate loaded">State</th><th title="Firmware, file type / container">Firmware / file</th>' +
	'<th title="Non-default settings; hover for the list">Settings</th>';

async function logs_message(req, res)
{
	try
	{
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		const id_msg = parseInt(req.params.id_msg, 10);
		if (!(id_msg > 0))
			return notFound(res);
		const before = parseInt(String(req.query.before || ''), 10) || 0;
		const [msg, rows] = await Promise.all([reports.getMessage(id_msg), reports.getMessageReports(id_msg, before > 0 ? before : 0)]);
		if (!msg)
			return notFound(res);

		const kindLink = '/logs/kind/' + encodeURIComponent(msg.id_msg_kind);
		let html = '<p><a href="' + makeLink(kindLink, {}) + '">Kind #' + e(msg.id_msg_kind) + '</a>: <code>' + e(msg.template) + '</code>' +
			(msg.blocked ? ' (blocked)' : '') + '</p>';
		html += '<p>Game: <a href="' + makeLink('/logs/game/' + encodeURIComponent(msg.id_game), {}) + '">' + e(msg.title) + '</a> (' + e(msg.id_game) + ')</p>';
		html += '<pre class="message-full">' + e(msg.message) + '</pre>';
		let status = 'Status: ' + e(msg.status);
		if (msg.resolved_version)
			status += ' at ' + e(msg.resolved_version);
		if (msg.resolve_note)
			status += ' (' + e(msg.resolve_note) + ')';
		html += '<p>' + status + '. ' + formatNumber(msg.hits) + ' hits from ' + e(fmtTime(msg.first_report)) + ' to ' + e(fmtTime(msg.latest_report)) +
			' UTC. Message #' + e(msg.id_msg) + '.</p>';
		html += '<p>Individual reports are stored since 2026-11-12, the newest ' + reports.REPORTS_PER_MESSAGE + ' per message' +
			(Number(msg.stored_reports) ? ' (' + formatNumber(msg.stored_reports) + ' stored for this one)' : '; none for this message yet') +
			'. Older hits only exist as the counters above. Hover a cell for details.</p>';

		if (rows.length)
		{
			html += '<table id="reporting-logs-table" class="reports-table"><tr><th>Time (UTC)</th><th>Version</th>' + REPORT_HEADERS + '</tr>';
			for (const r of rows)
			{
				html += '<tr>' + cell(e(fmtTime(r.reported_at)), '', 'latest_report-text') +
					cell('<a href="' + makeLink('/logs/version/' + encodeURIComponent(r.version || ''), {}) + '">' + e(r.version) + '</a>', '', 'version') +
					reportCells(r).join('') + '</tr>';
			}
			html += '</table>';
		}
		if (rows.length >= reports.PAGE_SIZE)
			html += '<p><a href="' + makeLink(req.path, { before: rows[rows.length - 1].id_report }) + '">Older &raquo;</a></p>';
		renderPage(res, 'Message #' + id_msg + ' - ' + String(msg.template).substr(0, 80), html);
	}
	catch (err)
	{
		fail(res, err);
	}
}

async function logs_all(req, res)
{
	try
	{
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		const before = parseInt(String(req.query.before || ''), 10) || 0;
		const rows = await reports.getRecentReports(before > 0 ? before : 0);

		let html = '<p>Every stored report as it came in, newest first: repeats of known messages too, and resolved/ignored ones ' +
			'(<a href="/logs">Recent logs</a> only lists messages seen for the first time). Stored since 2026-11-12. ' +
			'Click a message for all its reports. What gets dropped before this is on <a href="/stats">Stats</a>.</p>';
		html += '<table id="reporting-logs-table" class="reports-table"><tr><th>Time (UTC)</th><th>Game</th><th>Version</th>' + REPORT_HEADERS +
			'<th>Message</th></tr>';
		for (const r of rows)
		{
			const status = r.status == 'new' ? '' : ' [' + r.status + ']';
			html += '<tr>' + cell(e(fmtTime(r.reported_at)), '', 'latest_report-text') +
				cell('<a href="' + makeLink('/logs/game/' + encodeURIComponent(r.id_game), {}) + '">' + e(r.title) + '</a>', r.id_game, 'game') +
				cell('<a href="' + makeLink('/logs/version/' + encodeURIComponent(r.version || ''), {}) + '">' + e(r.version) + '</a>', '', 'version') +
				reportCells(r).join('') +
				cell('<a href="' + makeLink('/logs/message/' + r.id_msg, {}) + '">' + e(r.message) + e(status) + '</a>', 'Kind #' + r.id_msg_kind, 'message') +
				'</tr>';
		}
		html += '</table>';
		let paging = [];
		if (before > 0)
			paging.push('<a href="' + makeLink(req.path, {}) + '">&laquo; Newest</a>');
		if (rows.length >= reports.PAGE_SIZE)
			paging.push('<a href="' + makeLink(req.path, { before: rows[rows.length - 1].id_report }) + '">Older &raquo;</a>');
		html += '<p>' + paging.join(' &nbsp; ') + '</p>';
		renderPage(res, 'All recent reports', html);
	}
	catch (err)
	{
		fail(res, err);
	}
}

// "v1.20.4-123-gabc" -> { key: 'v1.20', value } for grouping by release series; null if it isn't a version.
function versionSeries(version)
{
	const m = /^v?(\d+)\.(\d+)/.exec(version);
	if (!m)
		return null;
	return { key: 'v' + Number(m[1]) + '.' + Number(m[2]), value: Number(m[1]) * 10000000 + Number(m[2]) * 100000 };
}

function versionStatsHtml(rows)
{
	const min = Number(settings.value('min_version_value')) || 0;
	const minTitle = min ? 'v' + Math.floor(min / 10000000) + '.' + Math.floor(min / 100000) % 100 + '.' + Math.floor(min / 10000) % 10 : '';
	const total = { message: { d1: 0, d7: 0, d30: 0 }, compat: { d1: 0, d7: 0, d30: 0 } };
	const series = new Map();
	const builds = new Map();
	for (const r of rows)
	{
		if (!total[r.type])
			continue;
		for (const k of ['d1', 'd7', 'd30'])
			total[r.type][k] += r[k];
		const ser = versionSeries(r.version);
		const key = ser ? ser.key : 'other';
		if (!series.has(key))
			series.set(key, { key, value: ser ? ser.value : -1, message: { d1: 0, d7: 0, d30: 0 }, compat: { d1: 0, d7: 0, d30: 0 } });
		const s = series.get(key);
		for (const k of ['d1', 'd7', 'd30'])
			s[r.type][k] += r[k];
		if (r.d7)
		{
			if (!builds.has(r.version))
				builds.set(r.version, { version: r.version, message: 0, compat: 0 });
			builds.get(r.version)[r.type] += r.d7;
		}
	}
	const pct = (n, of) => of ? ' <span class="muted">(' + (100 * n / of).toFixed(1) + '%)</span>' : '';

	let html = '<h3>Incoming reports by PPSSPP version</h3><p>Every incoming report, counted by the version it says it\'s from before ' +
		'anything is dropped. Biased: only from users with reporting turned on, and builds that hit more problems report more. By UTC ' +
		'day; "7 days" includes today. Versions older than ' + e(minTitle || 'the cutoff') + ' are dropped; "other" is reports without a ' +
		'parseable version (custom builds with a bare git hash, homebrew tools...).</p>';
	html += '<table id="reporting-logs-table" class="stats-table"><tr><th>Series</th><th>Messages today</th><th>Messages 7 days</th>' +
		'<th>Messages 30 days</th><th>Compat 7 days</th><th>Compat 30 days</th><th>Stored</th></tr>';
	const list = Array.from(series.values()).sort((a, b) => b.value - a.value);
	for (const s of list)
	{
		const kept = s.value < 0 ? 'no' : (s.value + 99999 < min ? 'no' : (s.value < min ? 'partly' : 'yes'));
		html += '<tr><td>' + e(s.key) + '</td>' +
			'<td class="games-text">' + formatNumber(s.message.d1) + pct(s.message.d1, total.message.d1) + '</td>' +
			'<td class="games-text">' + formatNumber(s.message.d7) + pct(s.message.d7, total.message.d7) + '</td>' +
			'<td class="games-text">' + formatNumber(s.message.d30) + '</td>' +
			'<td class="games-text">' + formatNumber(s.compat.d7) + pct(s.compat.d7, total.compat.d7) + '</td>' +
			'<td class="games-text">' + formatNumber(s.compat.d30) + '</td>' +
			'<td>' + kept + '</td></tr>';
	}
	html += '<tr><td><b>All</b></td><td class="games-text"><b>' + formatNumber(total.message.d1) + '</b></td><td class="games-text"><b>' +
		formatNumber(total.message.d7) + '</b></td><td class="games-text"><b>' + formatNumber(total.message.d30) + '</b></td><td class="games-text"><b>' +
		formatNumber(total.compat.d7) + '</b></td><td class="games-text"><b>' + formatNumber(total.compat.d30) + '</b></td><td></td></tr></table>';

	const top = Array.from(builds.values()).sort((a, b) => (b.message + b.compat) - (a.message + a.compat)).slice(0, 30);
	html += '<h3>Top builds, last 7 days</h3><table id="reporting-logs-table" class="stats-table"><tr><th>Version</th><th>Messages</th>' +
		'<th>Compat</th><th>Stored</th></tr>';
	for (const b of top)
	{
		const kept = !settings.isVersionTooOld(b.version) && !settings.isVersionBlocked(b.version);
		html += '<tr><td>' + e(b.version) + '</td><td class="games-text">' + formatNumber(b.message) + '</td><td class="games-text">' +
			formatNumber(b.compat) + '</td><td>' + (kept ? 'yes' : 'no') + '</td></tr>';
	}
	html += '</table>';
	return html;
}

async function stats_page(req, res)
{
	try
	{
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		const { totals, hours } = await stats.getSummary();
		const names = stats.OUTCOMES;
		const order = Object.keys(names);
		const pct = (n, of) => of ? ' <span class="muted">(' + (100 * n / of).toFixed(1) + '%)</span>' : '';

		let html = '<p>What happened to incoming reports: stored, or why they were dropped. Counted since 2026-11-12, per whole UTC ' +
			'hour (so "last 24 hours" is the current hour plus the 24 before it, give or take). Dropped reports are answered as accepted, so ' +
			'the app doesn\'t retry them.</p>';
		for (const type of ['message', 'compat'])
		{
			const rows = totals.filter(t => t.type == type).sort((a, b) =>
				(order.indexOf(a.outcome) + 1 || 99) - (order.indexOf(b.outcome) + 1 || 99));
			const sum = { h1: 0, h24: 0, d7: 0, d30: 0, total: 0 };
			for (const r of rows)
				for (const k in sum)
					sum[k] += r[k];
			html += '<h3>' + (type == 'message' ? 'Log messages (/report/message)' : 'Compatibility reports (/report/compat)') + '</h3>';
			html += '<table id="reporting-logs-table" class="stats-table"><tr><th>Outcome</th><th>This hour</th><th>24 hours</th>' +
				'<th>7 days</th><th>30 days</th><th>All</th></tr>';
			for (const r of rows)
			{
				html += '<tr><td>' + e(names[r.outcome] || r.outcome) + '</td>';
				for (const k of ['h1', 'h24', 'd7', 'd30', 'total'])
					html += '<td class="games-text">' + formatNumber(r[k]) + (k == 'h24' || k == 'd7' ? pct(r[k], sum[k]) : '') + '</td>';
				html += '</tr>';
			}
			html += '<tr><td><b>Received</b></td>';
			for (const k of ['h1', 'h24', 'd7', 'd30', 'total'])
				html += '<td class="games-text"><b>' + formatNumber(sum[k]) + '</b></td>';
			html += '</tr></table>';
		}

		html += '<h3>Per hour, last 48 hours</h3><table id="reporting-logs-table" class="stats-table"><tr><th>Hour (UTC)</th>' +
			'<th>Messages stored / received</th><th>Compat stored / received</th></tr>';
		const byHour = new Map();
		for (const h of hours)
		{
			const key = fmtTime(h.hour).substr(0, 13);
			if (!byHour.has(key))
				byHour.set(key, {});
			byHour.get(key)[h.type] = h;
		}
		for (const [key, t] of Array.from(byHour.entries()).sort().reverse())
		{
			const c = x => x ? formatNumber(x.stored) + ' / ' + formatNumber(x.received) : '';
			html += '<tr><td class="latest_report-text">' + e(key) + ':00</td><td class="games-text">' + c(t.message) + '</td>' +
				'<td class="games-text">' + c(t.compat) + '</td></tr>';
		}
		html += '</table>';
		html += versionStatsHtml(await stats.getVersionSummary());
		renderPage(res, 'Report stats', html);
	}
	catch (err)
	{
		fail(res, err);
	}
}

// ?min_version=1.20.4 or v1.20.4 (dev builds after it, like v1.20.4-605-g..., count as newer).
function parseMinVersion(raw)
{
	if (typeof raw != 'string' || raw.trim() === '')
		return { value: 0, invalid: false };
	let title = raw.trim().substr(0, 32);
	if (!title.startsWith('v'))
		title = 'v' + title;
	const value = lookups.calcVersionValue(title);
	return value ? { value, title } : { value: 0, invalid: true };
}

function formatNumber(n)
{
	if (n === null || n === undefined)
		return '';
	return Number(n).toLocaleString('en-US');
}

// path + query string from the non-empty values of params.  The result is HTML-escaped, ready for an href.
function makeLink(path, params)
{
	const parts = [];
	for (const k in params)
	{
		if (params[k] !== undefined && params[k] !== null && params[k] !== '')
			parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
	}
	return escape_html(path + (parts.length ? '?' + parts.join('&') : ''));
}

function escape_html(text)
{
	return text.replace(/&/g, '&amp;').
		replace(/</g, '&lt;').
		replace(/"/g, '&quot;').
		replace(/'/g, '&#039;');
}
