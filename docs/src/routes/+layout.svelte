<script>
	import "./layout.css";
	import favicon from "$lib/assets/favicon.svg";
	import init from "overfade";
	import { onMount } from "svelte";

	let { children } = $props();

	onMount(init);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta
		name="description"
		content="PlaySocket is a WebSocket synchronization library that handles optimistic updates for you."
	/>
</svelte:head>

<main class="max-w-2xl mx-auto w-[calc(100%-2rem)] my-4">
	{@render children()}
</main>
