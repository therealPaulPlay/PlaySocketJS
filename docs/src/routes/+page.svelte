<script>
	import InteractiveBox from "$lib/components/InteractiveBox.svelte";
	import LatencyButtonExample from "$lib/components/LatencyButtonExample.svelte";
	import RenderCode from "$lib/components/RenderCode.svelte";
	import Button from "$lib/components/ui/button/button.svelte";
	import { ArrowRight, Github } from "@hugeicons/core-free-icons";
	import { HugeiconsIcon } from "@hugeicons/svelte";
	import { asset, resolve } from "$app/paths";

	let { data } = $props();
</script>

<img
	alt="artwork"
	src={asset("/images/clear-connection-wassily-kandinsky.jpg")}
	class="w-full sm:mt-14 h-auto mb-2 object-contain object-left sm:max-h-[55dvh] sm:min-h-100"
/>

<article class="prose prose-h1:mt-14 prose-h1:mb-4 mb-20">
	<p class="text-muted-foreground/50 text-xs">Clear Connection, Wassily Kandinsky, 1925</p>

	<h1>PlaySocket</h1>

	<p>
		PlaySocket is a WebSocket-based synchronization library built for creating collaborative experiences, such as
		multiplayer games.
	</p>
	<p>
		The two unique aspects of PlaySocket are its <span class="bg-border rounded px-0.5">CRDT-based architecture</span>
		that allows for optimistic updates without any extra logic, and its
		<span class="bg-border rounded px-0.5">synchronized storage</span> that works beautifully with reactive frontend frameworks
		such as React or Svelte.
	</p>
	<p>
		Moreover, the library enables <span class="bg-border rounded px-0.5">rapid prototyping</span>, as complete
		multiplayer logic can be client-only during active development with server-side validation added later.
	</p>
	<p>
		Security and reliability are top priorities of PlaySocket. Out of the box, it protects against XSS attacks and
		includes message rate limiting and automatic reconnection handling.
	</p>
	<p>
		The library is <span class="bg-border rounded px-0.5">lightweight</span>, relying only on WS and MessagePack.
	</p>

	<h2>The problem</h2>

	<p>
		When building a UX that combines user input with server requests, latency becomes troublesome. It feels <i>odd</i> when
		a UI update isn't immediate.
	</p>
	<InteractiveBox><LatencyButtonExample /></InteractiveBox>
	<p>
		Optimistic updates – updating the UI before the request resolves, and reverting on error – are what developers reach
		for in these scenarios.
	</p>
	<p>
		When there's only one user making changes to an interface at a time, this is relatively trivial to do. The real
		complexity arises when multiple users can interact with an interface simultaneously.
	</p>
	<h3>Ordering complexity</h3>

	<p>
		Let's think through a scenario where two users collaborate to pick a color in an optimistically-updated user
		interface:
	</p>
	<ol>
		<li>
			Michael selects <span class="bg-border rounded px-0.5">green</span>, and his UI shows green.
		</li>
		<li>
			Lana selects <span class="bg-border rounded px-0.5">blue</span>, and her UI shows blue.
		</li>
		<li>Server receives <span class="bg-border rounded px-0.5">green</span> and broadcasts it to all clients.</li>
		<li>Lana's UI now shows <span class="bg-border rounded px-0.5">green</span>, Michael's already does.</li>
		<li>Server receives <span class="bg-border rounded px-0.5">blue</span> and broadcasts it to all clients.</li>
		<li>Lana's UI now shows <span class="bg-border rounded px-0.5">blue</span> again, Michael's now shows blue.</li>
	</ol>
	<p>
		The issue with this flow is that Lana's UI briefly flashes green, even though that color was selected by Michael <i
			>before</i
		>
		her selection.
	</p>
	<p>
		PlaySocket uses a <span class="bg-border rounded px-0.5">vector clock</span> to avoid this issue – with it, Lana's client,
		upon receiving Michael's color update, knows that her selection is newer than Michael's and her UI remains unchanged.
	</p>
	<h3>Merging complexity</h3>
	<p>
		Ordering isn't the only thing that can go wrong when multiple users act at once. Let's think through a scenario
		where two players add items to a shared, optimistically-updated inventory at the same time:
	</p>
	<ol>
		<li>The inventory starts out as <span class="bg-border rounded px-0.5">torch</span>.</li>
		<li>
			Michael adds <span class="bg-border rounded px-0.5">rope</span>, and his UI shows
			<span class="bg-border rounded px-0.5">torch, rope</span>.
		</li>
		<li>
			Lana adds <span class="bg-border rounded px-0.5">map</span>, and her UI shows
			<span class="bg-border rounded px-0.5">torch, map</span>.
		</li>
		<li>
			Server receives Michael's inventory <span class="bg-border rounded px-0.5">torch, rope</span> and broadcasts it.
		</li>
		<li>
			Server receives Lana's inventory <span class="bg-border rounded px-0.5">torch, map</span> and broadcasts it.
		</li>
		<li>
			Both UIs now show <span class="bg-border rounded px-0.5">torch, map</span>.
		</li>
	</ol>
	<p>
		The issue with this flow is that each client sends the <i>entire new value</i> of the invetory, so whichever update arrives
		last wins. Michael's addition to the inventory, the rope, is silently lost.
	</p>
	<p>
		PlaySocket avoids this by describing changes as <span class="bg-border rounded px-0.5">operations</span>. Instead of
		setting the whole inventory, both clients send an
		<span class="bg-border rounded px-0.5">array-add</span> operation. The two changes simply combine, and every client converges
		to the expected result.
	</p>

	<h2>A quick example</h2>

	<p>
		The code below isn't quite production ready, but should give you an idea of how the library can be used to solve the
		inventory problem.
	</p>

	<RenderCode {...data.clientInventoryExample} text="Client" />
	<RenderCode {...data.serverInventoryExample} text="Server" class="mt-4" />

	<p>
		The magic part here is that <span class="bg-border rounded px-0.5">updateStorage()</span> is synchronous. The
		storage updates – and <span class="bg-border rounded px-0.5">storageUpdated</span> fires – immediately. You don't need
		to think about handling optimistic updates yourself.
	</p>

	<h2>Get started</h2>

	<p>To get started with PlaySocket, please refer to the documentation.</p>
	<Button href={resolve("/documentation")} class="no-underline"
		>Documentation <HugeiconsIcon icon={ArrowRight} strokeWidth={2} /></Button
	>
	<Button variant="link" target="_blank" href="https://github.com/therealPaulPlay/PlaySocketJS"
		>GitHub repository <HugeiconsIcon icon={Github} strokeWidth={2} /></Button
	>
</article>
