<script>
	import RenderCode from "$lib/components/RenderCode.svelte";

	let { data } = $props();
</script>

<article class="prose prose-h1:mt-14 prose-h1:mb-4 prose-table:mb-12 prose-table:mt-6 prose-th:text-nowrap max-md:px-4 text-pretty">
	<h1>Documentation</h1>
    <p>Everything you need to know to build with PlaySocket.</p>
	{#each data.apiDocsSegments as segment}
		{#if segment.html}
			{@html segment.html}
		{:else}
			<RenderCode code={segment.code} language={segment.language} class="my-4" />
		{/if}
	{/each}
</article>
