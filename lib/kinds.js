'use strict';

const pool = require('./db');

// Message kinds marked blocked (report_message_kinds.blocked = 1, set with tools/kind) are known noise: incoming
// messages of those kinds are accepted but dropped.  The list is reloaded every minute.
const UPDATE_INTERVAL = 60 * 1000;

let blocked = new Set();

refresh();
const intervalID = setInterval(refresh, UPDATE_INTERVAL);
pool.onEnd(() => clearInterval(intervalID));

async function refresh()
{
	try
	{
		const [rows] = await pool.query(`
			SELECT id_msg_kind
			FROM report_message_kinds
			WHERE blocked = 1`, null);
		blocked = new Set(rows.map(row => Number(row.id_msg_kind)));
	}
	catch (err)
	{
		console.error('Error updating blocked message kinds', err);
	}
}

module.exports.isBlocked = function (id_msg_kind)
{
	return blocked.has(Number(id_msg_kind));
};
