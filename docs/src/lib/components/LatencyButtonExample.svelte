<script>
	import { innerWidth } from "svelte/reactivity/window";
	import Button from "./ui/button/button.svelte";
	import Separator from "./ui/separator/separator.svelte";

	let button1Clicked = $state(false);
	let button2Clicked = $state(false);
</script>

<div class="grow text-center content-center">
	<Button class="min-w-25" variant={button2Clicked ? "secondary" : undefined} onclick={() => (button2Clicked = true)}
		>{button2Clicked ? "Active" : "Activate"}</Button
	>
	<p class="text-muted-foreground mt-2.5 text-sm">Instant</p>
</div>
<Separator orientation={innerWidth.current < 768 ? "horizontal" : "vertical"} class="md:h-20! max-md:my-4 md:mx-4" />
<div class="grow text-center content-center">
	<Button
		class="min-w-25"
		variant={button1Clicked ? "secondary" : undefined}
		onclick={() => setTimeout(() => (button1Clicked = true), 500)}>{button1Clicked ? "Active" : "Activate"}</Button
	>
	<p class="text-muted-foreground mt-2.5 text-sm">Delayed</p>
</div>
