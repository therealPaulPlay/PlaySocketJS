import { codeToHtml } from "shiki";

// Highlight code with shiki (server-side, so this happens during prerendering)
export async function highlight(code, language = "javascript") {
	const html = await codeToHtml(code, {
		lang: language,
		theme: "vitesse-light",
		transformers: [
			{
				pre(node) {
					this.addClassToHast(node, "of-left of-right of-length-2"); // Put overfade classes on the scrollable pre
				},
			},
		],
	});
	return { code, html };
}
