'use strict';

// Mark message kinds as blocked (noise): incoming messages of a blocked kind are accepted but dropped.
// Run through tools/kind, which loads ./config.  See README.server.md.
//
//   tools/kind list                 blocked kinds
//   tools/kind show <id>...         a kind's text, blocked flag and message count
//   tools/kind block <id>...
//   tools/kind unblock <id>...

const pool = require('../lib/db');

async function show(ids)
{
	const [rows] = await pool.query(`
		SELECT mk.id_msg_kind, mk.blocked, LEFT(mk.message, 120) AS message,
			(SELECT COUNT(*) FROM report_messages AS m WHERE m.id_msg_kind = mk.id_msg_kind) AS messages
		FROM report_message_kinds AS mk
		WHERE ${ids ? 'mk.id_msg_kind IN (:ids)' : 'mk.blocked = 1'}
		ORDER BY mk.id_msg_kind`, { ids });
	for (const row of rows)
		console.log(`${String(row.id_msg_kind).padStart(5)}  ${row.blocked ? 'BLOCKED' : '       '}  ${String(row.messages).padStart(6)} msgs  ${row.message}`);
	if (ids)
	{
		const found = new Set(rows.map(row => row.id_msg_kind));
		for (const id of ids)
			if (!found.has(id))
				console.log(`${String(id).padStart(5)}  (no such kind)`);
	}
	else if (rows.length === 0)
		console.log('No kinds are blocked.');
}

async function main()
{
	const [command, ...rest] = process.argv.slice(2);
	const ids = rest.map(Number);
	if (ids.some(id => !Number.isInteger(id) || id <= 0))
		throw new Error('Kind ids must be positive numbers (the "Kind #" column on /logs/kinds).');

	if (command === 'list' && ids.length === 0)
		return show(null);
	if (ids.length === 0 || !['show', 'block', 'unblock'].includes(command))
	{
		console.log('usage: tools/kind list | show <id>... | block <id>... | unblock <id>...');
		process.exitCode = 2;
		return;
	}
	if (command !== 'show')
	{
		const [result] = await pool.query(`
			UPDATE report_message_kinds
			SET blocked = :blocked
			WHERE id_msg_kind IN (:ids)`, { blocked: command === 'block' ? 1 : 0, ids });
		console.log(`${command}: ${result.changedRows} changed (takes effect in the server within a minute)`);
	}
	return show(ids);
}

main()
	.catch(err => { console.error(err.message); process.exitCode = 1; })
	.finally(() => pool.end());
