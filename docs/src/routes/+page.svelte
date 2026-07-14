<script>
	import InteractiveBox from "$lib/components/InteractiveBox.svelte";
	import LatencyButtonExample from "$lib/components/LatencyButtonExample.svelte";
</script>

<img alt="artwork" src="/images/clear-connection-wassily-kandinsky.jpg" class="w-full h-auto mb-2" />

<article class="prose max-md:px-4 text-pretty">
	<p class="text-muted-foreground/50 text-xs">Clear Connection, Wassily Kandinsky, 1925</p>

	<h1 class="mt-14 mb-4">PlaySocketJS</h1>

	<p>
		PlaySocketJS is a WebSocket-based synchronization library built for creating collaborative experiences, such as
		multiplayer games.
	</p>
	<p>
		The two unique aspects of PlaySocketJS are its <span class="bg-border rounded px-0.5">CRDT-based architecture</span>
		that allows for optimistic updates without any extra logic, and its
		<span class="bg-border rounded px-0.5">synchronized storage</span> that works beautifully with reactive frontend frameworks
		such as React or Svelte.
	</p>
	<p>
		Moreover, the library enables <span class="bg-border rounded px-0.5">rapid prototyping</span>, as complete
		multiplayer logic can be client-only during active development with server-side validation added later. Validating
		client input is made easy through callbacks and helper functions.
	</p>
	<p>
		Security is a top priority of PlaySocketJS. Out of the box, it protects against XSS attacks and comes with thorough
		WebSocket rate limiting.
	</p>
	<p>
		The library is also <span class="bg-border rounded px-0.5">lightweight</span>, relying only on two dependencies:
		MessagePack and WS.
	</p>

	<h2>The problem</h2>

	<p>
		When building a UX that combines user input with server requests, latency becomes a problem. It feels <i>odd</i> when
		a UI update triggered by an interaction isn't immediate.
	</p>
	<InteractiveBox><LatencyButtonExample /></InteractiveBox>
	<p>
		Optimistic updates – updating the UI before the request resolves, and reverting on error – are what developers reach
		for in these scenarios.
	</p>
	<h3>Ordering complexity</h3>
	<p>
		In situations where there's only one user making changes to an interface at a time, this is relatively trivial to
		do. The real complexity comes when multiple users can interact with an interface simultaneously.
	</p>
	<p>Let's think through a scenario where two users collaborate to pick a color:</p>
	<ol>
		<li>
			Michael selects <span class="bg-border rounded px-0.5">green</span>, and his UI optimistically updates to green
		</li>
		<li>
			Lana selects <span class="bg-border rounded px-0.5">blue</span>, and her UI optimistically updates to blue
		</li>
		<li>Server receives <span class="bg-border rounded px-0.5">green</span> and broadcasts it to all clients</li>
		<li>Lana's UI now shows <span class="bg-border rounded px-0.5">green</span>, Michael's already does</li>
		<li>Server receives <span class="bg-border rounded px-0.5">blue</span> and broadcasts it to all clients</li>
		<li>Lana's UI now shows <span class="bg-border rounded px-0.5">blue</span> again, Michael's now shows blue</li>
	</ol>
	<p>
		The issue with this flow is that Lana's UI briefly flashes green, even though that color was selected by Michael <i
			>before</i
		>
		her selection.
	</p>
	<p>
		PlaySocketJS uses a <span class="bg-border rounded px-0.5">vector clock</span> to avoid this issue – with it, Lana's
		client, upon receiving Michael's color update, knows that her selection is newer than Michael's and her UI remains unchanged.
	</p>
	<h3>Merging complexity</h3>
	<p>
		Ordering isn't the only thing that goes wrong when multiple users act at once. When two users modify the same piece
		of data simultaneously, one change can silently overwrite the other.
	</p>
	<p>Let's think through a scenario where two players add items to a shared inventory:</p>
	<ol>
		<li>Two players share an inventory that starts out as <span class="bg-border rounded px-0.5">["torch"]</span></li>
		<li>
			Michael adds <span class="bg-border rounded px-0.5">rope</span>, and his UI optimistically shows
			<span class="bg-border rounded px-0.5">["torch", "rope"]</span>
		</li>
		<li>
			Lana adds <span class="bg-border rounded px-0.5">map</span>, and her UI optimistically shows
			<span class="bg-border rounded px-0.5">["torch", "map"]</span>
		</li>
		<li>
			Server receives Michael's list <span class="bg-border rounded px-0.5">["torch", "rope"]</span> and broadcasts it
		</li>
		<li>
			Server receives Lana's list <span class="bg-border rounded px-0.5">["torch", "map"]</span> and broadcasts it
		</li>
		<li>
			Every UI now shows <span class="bg-border rounded px-0.5">["torch", "map"]</span>
		</li>
	</ol>
	<p>
		The issue with this flow is that each client sends the <i>entire new value</i> of the list, so whichever update arrives
		last wins. Michael's addition to the inventory, the rope, is silently lost.
	</p>
	<p>
		PlaySocketJS avoids this by describing changes as <span class="bg-border rounded px-0.5">operations</span>. Instead
		of setting the whole array, both clients send an
		<span class="bg-border rounded px-0.5">array-add</span> operation. The two changes simply combine, and every client converges
		to the expected result.
	</p>

	<h2>A quick example</h2>

	<p>This is how PlaySocketJS could be used to solve the inventory problem.</p>

    <p>WIP, show code here.</p>

	<h2>Getting started</h2>

	<p>To get started, install the library via your package manager of choice.</p>
</article>
