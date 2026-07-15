import { readFileSync } from "node:fs";
import { marked } from "marked";
import markedAlert from "marked-alert";

marked.use(markedAlert()); // Render GitHub-style alerts like [!TIP]
marked.use({ hooks: { postprocess: (html) => html.replaceAll("<table>", '<table class="of-left of-right of-length-2">') } }); // Add overfade classes to horizontally scrollable table

export const prerender = true;

export function load() {
	const readme = readFileSync("../README.md", "utf8");
	const api = readme.split("<!-- docs-start -->")[1].split("<!-- docs-end -->")[0]; // Only render the docs part of the readme

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
