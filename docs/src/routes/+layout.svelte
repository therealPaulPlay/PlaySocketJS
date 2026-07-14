<script>
	import "./layout.css";
	import favicon from "$lib/assets/favicon.svg";
	import init from "overfade";
	import { onMount } from "svelte";

	let { children } = $props();

	onMount(init);
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<main class="max-w-2xl mx-auto pb-20 pt-10">
	{@render children()}
</main>
