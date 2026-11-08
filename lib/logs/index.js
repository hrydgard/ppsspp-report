const data = require('./data');
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
};

function report_message(req, res)
{
	const upload = multer().fields([]);
	upload(req, res, async function (err)
	{
		try
		{
			if (err)
				throw err;

			await data.addMessage(req.body);
		}
		catch (err)
		{
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
		if (args.id_msg_kind !== undefined)
		{
			const kindPath = '/logs/kind/' + encodeURIComponent(args.id_msg_kind);
			if (args.text !== undefined)
				summary += ' Only messages with exactly this text: <code>' + escape_html(args.text) + '</code>. <a href="' +
					makeLink(kindPath, { status: args.status }) + '">Show all of this kind</a>.';
			summary += ' <a href="' + makeLink(kindPath + '/grouped', { status: args.status }) + '">Group by message text</a>';
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
			args.status = req.query.status;

		let kinds = await data.getKindList(args);
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

		kinds = kinds.map(function (row)
		{
			row.message_uri = '/logs/kind/' + encodeURIComponent(row.id_msg_kind);
			row.id_msg_kind = String(row.id_msg_kind);
			row.blocked_text = row.blocked ? 'blocked' : '';

			for (let k in row)
			{
				if (typeof row[k] == 'string')
					row[k] = escape_html(row[k]);
			}

			return row;
		});

		const showingAll = args.status === 'any';
		const status_uri = showingAll ? '/logs/kinds' : '/logs/kinds?status=any';
		const status_text = showingAll ? 'Show only kinds with unresolved messages' : 'Show all kinds, including fully resolved ones';
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
				message_uri: makeLink(kindPath, { status: args.status, text: String(row.message) }),
				games: formatNumber(row.games),
				messages: formatNumber(row.messages),
				hits: formatNumber(row.hits),
				latest_report: row.latest_report ? row.latest_report.toISOString().replace(/T.*$/, '') : '',
			};
		});

		const first = (args.page - 1) * data.GROUPED_PAGE_SIZE + 1;
		let summary = rows.length == 0 ? 'No messages.' :
			'Distinct message texts ' + formatNumber(first) + '-' + formatNumber(first + rows.length - 1) + ', most hits first. ' +
			'Games and Rows count where each text was seen; click a text for its games. Refreshed every 10 minutes. ' +
			'<a href="' + makeLink(kindPath, { status: args.status }) + '">Back to the list by game</a>';
		let paging = [];
		if (args.page > 1)
			paging.push('<a href="' + makeLink(req.path, { status: args.status, page: args.page - 1 }) + '">&laquo; Previous</a>');
		if (result.more)
			paging.push('<a href="' + makeLink(req.path, { status: args.status, page: args.page + 1 }) + '">Next &raquo;</a>');

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
