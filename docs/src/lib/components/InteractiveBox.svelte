<script>
	import Button from "./ui/button/button.svelte";
	import { HugeiconsIcon } from "@hugeicons/svelte";
	import { Refresh01Icon } from "@hugeicons/core-free-icons";

	let { children } = $props();

	let keyVal = $state(0);
</script>

<div class="rounded-sm bg-white p-8 flex gap-4 flex-col md:flex-row not-prose relative">
	{#key keyVal}
		{@render children?.()}
	{/key}
	<Button size="icon" variant="secondary" class="absolute right-4 bottom-4" onclick={() => keyVal++}
		><HugeiconsIcon icon={Refresh01Icon} strokeWidth={2} /></Button
	>
</div>
