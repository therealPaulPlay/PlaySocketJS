<script>
	import Button from "./ui/button/button.svelte";
	import { HugeiconsIcon } from "@hugeicons/svelte";
	import { CopyCheckIcon, CopyIcon } from "@hugeicons/core-free-icons";

	let { code = "", html = "", text = "", class: classes = "" } = $props();

	let showCopied = $state(false);
	let hideCopiedTimeout;
</script>

<div
	class="bg-white rounded-sm overflow-hidden not-prose [&>pre]:text-sm [&>pre]:p-4 [&>pre]:overflow-x-auto relative group {classes}"
>
	{#if text}
		<div
			class="transition duration-150 absolute top-0 right-15 rounded-b-sm bg-muted px-2 z-1 opacity-0 group-hover:opacity-100"
		>
			<p class="mt-1">{text}</p>
		</div>
	{/if}
	<div
		class="transition duration-150 absolute top-0 right-4 rounded-b-sm bg-muted z-1 opacity-0 group-hover:opacity-100"
	>
		<Button
			size="icon"
			variant="ghost"
			class="w-8 h-6 mt-1"
			onclick={async () => {
				try {
					await navigator.clipboard.writeText(code);
				} catch (error) {
					console.error("Error copying code:", error);
				}
				showCopied = true;
				clearTimeout(hideCopiedTimeout);
				hideCopiedTimeout = setTimeout(() => (showCopied = false), 1500);
			}}
		>
			{#if showCopied}
				<HugeiconsIcon icon={CopyCheckIcon} strokeWidth={2} />
			{:else}
				<HugeiconsIcon icon={CopyIcon} strokeWidth={2} />
			{/if}
		</Button>
	</div>
	{@html html}
</div>
