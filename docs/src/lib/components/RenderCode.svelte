<script>
	import { codeToHtml } from "shiki";
	import { onMount } from "svelte";
	import Button from "./ui/button/button.svelte";
	import { HugeiconsIcon } from "@hugeicons/svelte";
	import { CopyCheckIcon, CopyIcon } from "@hugeicons/core-free-icons";

	let { language = "javascript", theme = "vitesse-light", code = "", text = "", class: classes = "" } = $props();

	let htmlContent = $state("");
	let showCopied = $state(false);

	onMount(async () => {
		htmlContent = await codeToHtml(code, {
			lang: language,
			theme,
			transformers: [
				{
					pre(node) {
						this.addClassToHast(node, "of-left of-right of-length-2"); // Put overfade classes on the scrollable pre
					},
				},
			],
		});
	});
</script>

<div
	class="bg-white rounded-sm overflow-hidden not-prose [&>pre]:p-4 [&>pre]:overflow-x-auto relative {classes}"
	class:min-h-25={!htmlContent}
	class:animate-pulse={!htmlContent}
>
	{#if text}
		<div class="absolute top-0 right-15 rounded-b-sm bg-muted px-2 z-1">
			<p class="mt-1">{text}</p>
		</div>
	{/if}
	<div class="absolute top-0 right-4 rounded-b-sm bg-muted z-1">
		<Button
			size="icon"
			variant="ghost"
			class="w-8 h-6 mt-1"
			onclick={() => {
				navigator.clipboard.writeText(code);
				showCopied = true;
				setTimeout(() => (showCopied = false), 1500);
			}}
		>
			{#if showCopied}
				<HugeiconsIcon icon={CopyCheckIcon} strokeWidth={2} />
			{:else}
				<HugeiconsIcon icon={CopyIcon} strokeWidth={2} />
			{/if}
		</Button>
	</div>
	{@html htmlContent}
</div>
