import { readFileSync } from "node:fs";
import { marked } from "marked";
import markedAlert from "marked-alert";

marked.use(markedAlert()); // Render GitHub-style alerts like [!TIP]

export const prerender = true;

export function load() {
	const readme = readFileSync("../README.md", "utf8");
	const api = readme.split("<!-- docs-start -->")[1].split("<!-- docs-end -->")[0]; // Only render the API part of the readme (skips the intro & license)

	// Split into alternating html & code segments, so that code blocks can be rendered with the RenderCode component
	const segments = [];
	let markdownChunk = "";

	for (const token of marked.lexer(api)) {
		if (token.type === "code") {
			if (markdownChunk.trim()) segments.push({ html: marked.parse(markdownChunk) });
			markdownChunk = "";
			segments.push({ code: token.text, language: token.lang || "javascript" });
		} else {
			markdownChunk += token.raw;
		}
	}
	if (markdownChunk.trim()) segments.push({ html: marked.parse(markdownChunk) });

	return { apiDocsSegments: segments };
}
