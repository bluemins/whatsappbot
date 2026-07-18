function parseRange(range) {
	// "11:00-21:00" -> { startMin, endMin }
	const [start, end] = range.split("-");
	const toMin = (hhmm) => {
		const [h, m] = hhmm.split(":").map(Number);
		return h * 60 + m;
	};
	return { startMin: toMin(start), endMin: toMin(end) };
}

function getLocalParts(timeZone) {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false
	});

	const parts = fmt.formatToParts(new Date());
	const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

	return {
		weekday: map.weekday, // Mon Tue Wed Thu Fri Sat Sun
		minutes: Number(map.hour) * 60 + Number(map.minute)
	};
}

export function isWithinBusinessHours() {
	const tz = process.env.BRAND_TIMEZONE || "Asia/Kolkata";
	const { weekday, minutes } = getLocalParts(tz);

	const monFri = process.env.BIZ_HOURS_MON_FRI || "11:00-21:00";
	const sat = process.env.BIZ_HOURS_SAT || "12:00-22:00";
	const sun = process.env.BIZ_HOURS_SUN || "12:00-20:00";

	let rangeStr = monFri;
	if (weekday === "Sat") rangeStr = sat;
	if (weekday === "Sun") rangeStr = sun;

	const { startMin, endMin } = parseRange(rangeStr);
	return minutes >= startMin && minutes < endMin;
}
