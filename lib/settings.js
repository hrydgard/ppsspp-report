const pool = require('./db');
const limits = require('./limits');
const lookups = require('./lookups');

// Update every 30 minutes.
const UPDATE_INTERVAL = 30 * 60 * 1000;

let cache = {};

refresh();
const intervalID = setInterval(refresh, UPDATE_INTERVAL);
pool.onEnd(() => clearInterval(intervalID));

async function refresh()
{
	try
	{
		const result = await pool.executeFirst(`
			SELECT *
			FROM settings`, null);
		cache = result;
	}
	catch (err)
	{
		console.error('Error updating settings', err);
	}

}

function value(key)
{
	if (key in cache)
		return cache[key];
	return null;
}

function isVersionBlocked(version)
{
	const blocked = String(value('blocked_version_strings')).split(',');
	return blocked.indexOf(String(version)) != -1;
}

// Reports from versions older than settings.min_version_value (e.g. 11900000 = v1.19.0) are accepted but dropped:
// they're almost all already-fixed bugs.  Unparseable versions (bare git hashes from custom builds) count as 0.
function isVersionTooOld(version)
{
	const min_ver = value('min_version_value');
	if (!min_ver)
		return false;
	const title = (typeof version == 'undefined' ? '' : String(version)).substr(0, limits.VERSION_TITLE_LENGTH);
	return lookups.calcVersionValue(title) < min_ver;
}

module.exports.value = value;
module.exports.isVersionTooOld = isVersionTooOld;
module.exports.isVersionBlocked = isVersionBlocked;
