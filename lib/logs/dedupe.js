'use strict';

const crypto = require('crypto');

// Exact repeats of a message report: the app sometimes posts the very same report twice (same body, same ticks, a second
// apart).  A report is a repeat when every field the app sent is identical to one seen in the last WINDOW_MS.  Only reports
// with ticks count: without them two genuine hits can look the same.  Checked synchronously before anything is awaited,
// so two copies arriving at the same moment can't both get through.  In memory only (a restart forgets).
const WINDOW_MS = 10 * 60 * 1000;

let seen = new Map();
let lastPrune = Date.now();

function keyOf(parameters)
{
	const keys = Object.keys(parameters).sort();
	const h = crypto.createHash('sha1');
	for (const k of keys)
		h.update(k + '\0' + String(parameters[k]) + '\0');
	return h.digest('base64');
}

// True if this exact report was already seen recently; otherwise remembers it and returns false.
module.exports.isRepeat = function (parameters)
{
	if (!/^[1-9]\d*$/.test(String(parameters.ticks || '')))
		return false;

	const now = Date.now();
	if (now - lastPrune > 60 * 1000)
	{
		for (const [k, t] of seen)
			if (now - t > WINDOW_MS)
				seen.delete(k);
		lastPrune = now;
	}

	const key = keyOf(parameters);
	const t = seen.get(key);
	if (t !== undefined && now - t <= WINDOW_MS)
		return true;
	seen.set(key, now);
	return false;
};

module.exports.WINDOW_MS = WINDOW_MS;
