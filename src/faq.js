/**
 * faq.js - Load and query FAQ entries from faq.json
 * Supports regex pattern matching and template variable substitution
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedFaq = null;

function resolveFaqPath() {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = path.dirname(__filename);
	return path.join(__dirname, "faq.json");
}

/**
 * Get environment variable with fallback
 */
function getEnv(key, fallback = "N/A") {
	return process.env[key] || fallback;
}

/**
 * Substitute template variables in text
 * E.g., ${BRAND_NAME} → process.env.BRAND_NAME
 */
function interpolateVariables(text) {
	return text.replace(/\$\{([A-Z_]+)\}/g, (match, varName) => {
		return getEnv(varName, match);
	});
}

/**
 * Load FAQ from faq.json, cache it, and compile regex patterns
 */
export function loadFaq() {
	if (cachedFaq) return cachedFaq;

	const faqPath = resolveFaqPath();

	if (!fs.existsSync(faqPath)) {
		throw new Error(`FAQ file not found at ${faqPath}`);
	}

	const raw = fs.readFileSync(faqPath, "utf-8");
	const json = JSON.parse(raw);

	if (!json || !Array.isArray(json.entries)) {
		throw new Error("faq.json must have an { entries: [] } structure");
	}

	cachedFaq = {
		...json,
		entries: json.entries.map((e) => {
			if (!e.id || !e.answer || !e.patterns) {
				throw new Error(
					`FAQ entry must have id, patterns (array), and answer. Got: ${JSON.stringify(e)}`
				);
			}

			// Compile regex patterns
			const regexes = e.patterns.map((p) => new RegExp(p, "i"));

			// Interpolate answer template
			const interpolatedAnswer = interpolateVariables(e.answer);

			return {
				...e,
				answer: interpolatedAnswer,
				_regexes: regexes
			};
		})
	};

	console.log(`✅ Loaded ${cachedFaq.entries.length} FAQ entries`);
	return cachedFaq;
}

/**
 * Match a query against FAQ entries
 * Returns the answer from the first matching entry, or null
 */
export function matchFaq(faq, query) {
	if (!query || typeof query !== "string") {
		return null;
	}

	const lower = query.toLowerCase();

	for (const entry of faq.entries) {
		for (const regex of entry._regexes) {
			if (regex.test(lower)) {
				console.log(`🎯 FAQ match: ${entry.id} for "${query}"`);
				return entry.answer;
			}
		}
	}

	return null;
}

/**
 * Search FAQs by keyword (returns matching entries, not just first)
 */
export function searchFaq(faq, keyword) {
	if (!keyword || typeof keyword !== "string") {
		return [];
	}

	const lower = keyword.toLowerCase();
	const matches = [];

	for (const entry of faq.entries) {
		for (const regex of entry._regexes) {
			if (regex.test(lower)) {
				matches.push(entry);
				break; // Only add each entry once
			}
		}
	}

	return matches;
}

/**
 * Get all FAQ entry IDs (useful for debugging)
 */
export function getAllFaqIds(faq) {
	return faq.entries.map((e) => e.id);
}
