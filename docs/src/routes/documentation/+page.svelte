<script>
	import RenderCode from "$lib/components/RenderCode.svelte";
	import Button from "$lib/components/ui/button/button.svelte";
	import { LeftToRightListBulletFreeIcons, X } from "@hugeicons/core-free-icons";
	import { HugeiconsIcon } from "@hugeicons/svelte";
	import { tick, untrack } from "svelte";
	import { innerWidth } from "svelte/reactivity/window";
	import { fly } from "svelte/transition";

	let { data } = $props();

	let isMobileNav = $derived(innerWidth.current < 1280);

	let articleEl = $state();
	let overviewShown = $state(false);
	let pageOverview = $state([]);
	let closestOverviewElement = $state();

	function buildPageOverview(element) {
		pageOverview = [];

		for (const child of element.children) {
			if (["h1", "h2", "h3", "h4"].includes(child.tagName?.toLowerCase())) {
				pageOverview.push({
					level: parseInt(child.tagName.slice(-1)),
					text: child.textContent,
					element: child,
				});
			}
		}

		setHighlightedOverviewElement();
	}

	function setHighlightedOverviewElement() {
		let closestEl = closestOverviewElement;
		let closestOffsetValue = Infinity;

		pageOverview.forEach((title) => {
			const element = title.element;
			const elementYFixed = element.getBoundingClientRect().top;

			if (elementYFixed < window.innerHeight * 0.5 && Math.abs(elementYFixed) < closestOffsetValue) {
				closestEl = element;
				closestOffsetValue = Math.abs(elementYFixed);
			}
		});

		closestOverviewElement = closestEl;
	}

	$effect(() => {
		data;
		if (articleEl) {
			untrack(() => {
				buildPageOverview(articleEl);
			});
		}
	});
</script>

<svelte:window onscroll={setHighlightedOverviewElement} />

{#if isMobileNav}
	<Button class="shadow-md fixed right-4 bottom-4 z-50 size-14" onclick={() => (overviewShown = !overviewShown)}>
		{#if !overviewShown}
			<HugeiconsIcon icon={LeftToRightListBulletFreeIcons} strokeWidth={2} class="size-5" />
		{:else}
			<HugeiconsIcon icon={X} strokeWidth={2} class="size-5" />
		{/if}
	</Button>
{/if}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed left-0 right-0 top-0 bottom-0 flex z-10 transition {isMobileNav && overviewShown
		? 'bg-foreground/25'
		: ''}"
	class:pointer-events-none={!(overviewShown && isMobileNav)}
	onclick={(e) => {
		if (e.target == e.currentTarget) overviewShown = false;
	}}
>
	{#if overviewShown || !isMobileNav}
		<div
			class="xl:mr-8 transition-[margin] mr-4 text-sm my-auto ml-auto bg-background pointer-events-auto rounded-sm"
			transition:fly={{ x: 250 }}
		>
			<div class="flex flex-col gap-2 of-top of-bottom max-h-[calc(100dvh-185px)] overflow-y-auto p-4">
				{#each pageOverview as title}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<p
						style:margin-left={title.level > 1 ? title.level - 1 + "rem" : ""}
						class:opacity-90={title.level == 2}
						class:opacity-65={title.level == 3}
						class:opacity-50={title.level >= 4}
						class:opacity-100={title.element === closestOverviewElement}
						class:underline={title.element === closestOverviewElement}
						onclick={() => {
							const topPos = title.element.getBoundingClientRect().top;
							const offsetPos = topPos + window.scrollY;
							window.scrollTo({
								top: offsetPos - 15,
							});
						}}
						class="cursor-pointer hover:opacity-100 active:opacity-100 transition duration-150"
					>
						{title.text}
					</p>
				{/each}
			</div>
		</div>
	{/if}
</div>

<article
	class="prose prose-h1:mt-14 prose-h1:mb-4 prose-table:mb-12 prose-table:overflow-x-auto prose-table:block prose-table:mt-6 prose-th:text-nowrap text-pretty mb-20"
	bind:this={articleEl}
>
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
