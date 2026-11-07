// Pia's service worker. It shows push notifications (the agent finished, an approval, a chat message), answers an
// approval from its notification, opens the right session when one is tapped, and hands things shared to Pia
// from other apps to the page. Only the fixed offline capture shell is cached.
const OFFLINE_CACHE = "pocket-offline-shell-v6";
const OFFLINE_ASSETS = ["/offline.html", "/offline.js", "/offline.css", "/quick-notes.js"];

self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(OFFLINE_CACHE);

            for (const path of OFFLINE_ASSETS) {
                const response = await fetch(path, { cache: "no-store" });

                if (!response.ok || response.redirected) {
                    throw new Error(`Could not cache offline asset: ${path}`);
                }

                await cache.put(path, response);
            }

            await self.skipWaiting();
        })(),
    );
});
self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            for (const name of await caches.keys()) {
                if (name.startsWith("pocket-offline-shell-") && name !== OFFLINE_CACHE) {
                    await caches.delete(name);
                }
            }

            await self.clients.claim();
        })(),
    );
});

/** Where shared things wait until the page picks them up; see `web/share.js`. */
const SHARE_CACHE = "pocket-share";

self.addEventListener("push", (event) => {
    let data = {};

    try {
        data = event.data?.json() ?? {};
    } catch {
        data = { title: "Pia", body: event.data?.text() ?? "" };
    }

    const approval = data.approval;
    // Allowing from the notification is offered only when the server says the whole call shows and this person may.
    const actions = approval
        ? [
              ...(approval.allow ? [{ action: "allow", title: "Allow" }] : []),
              { action: "deny", title: "Deny" },
          ]
        : [];

    event.waitUntil(
        Promise.all([
            self.registration.showNotification(data.title || "Pia", {
                body: data.body || "",
                tag: data.tag,
                renotify: Boolean(data.tag),
                icon: "/icon.svg",
                actions,
                data: { url: data.url || "/", approval },
            }),
            // A dot on the home-screen icon; the app sets the real count once it opens.
            self.navigator.setAppBadge?.().catch(() => {}),
        ]),
    );
});

/** Answer an approval with this device's sign-in. Only a failure shows: the notification going away is the answer. */
async function answerApproval(approval, allow, data) {
    let problem;

    try {
        const response = await fetch(`/api/approvals/${encodeURIComponent(approval.id)}`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ allow }),
        });

        if (!response.ok) {
            problem =
                (await response.json().catch(() => ({}))).error ??
                `The server answered ${response.status}.`;
        }
    } catch {
        problem = "Pia could not be reached.";
    }

    if (problem === undefined) {
        return;
    }

    await self.registration.showNotification(`Could not ${allow ? "allow" : "deny"} the call`, {
        body: problem,
        icon: "/icon.svg",
        data: { url: data.url },
    });
}

async function openUrl(url) {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);

    // Pia's notifications open its panel over whatever the window shows, rather than take the window elsewhere.
    if (open && new URL(url).searchParams.has("pip")) {
        await open.focus();
        open.postMessage({ type: "pocket.pia" });

        return;
    }

    if (open) {
        await open.focus();

        try {
            await open.navigate(url);

            return;
        } catch {
            // Not controlled by this worker yet: open a new window instead.
        }
    }

    await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data ?? {};

    if ((event.action === "allow" || event.action === "deny") && data.approval) {
        event.waitUntil(answerApproval(data.approval, event.action === "allow", data));

        return;
    }

    event.waitUntil(openUrl(new URL(data.url || "/", self.location.origin).href));
});

/**
 * Something shared to Pia from another app (the manifest's share target) arrives as a form post. Keep it until
 * the page picks it up, then open the page to choose where it goes. Any website could post a form here too, and
 * nothing tells it apart from a share; it only fills in a message the person still reads and sends themselves.
 */
async function receiveShare(request) {
    let form;

    try {
        form = await request.formData();
    } catch {
        return Response.redirect("/?share=failed", 303);
    }

    const id = crypto.randomUUID();
    const cache = await caches.open(SHARE_CACHE);
    const files = form.getAll("files").filter((file) => file instanceof File && file.size > 0);
    const text = (name) => (typeof form.get(name) === "string" ? form.get(name) : "");
    const meta = {
        title: text("title"),
        text: text("text"),
        url: text("url"),
        files: files.map((file) => ({ name: file.name, type: file.type })),
    };

    await cache.put(
        `/share/${id}/meta`,
        new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }),
    );
    await Promise.all(
        files.map((file, index) =>
            cache.put(
                `/share/${id}/file/${index}`,
                new Response(file, {
                    headers: { "content-type": file.type || "application/octet-stream" },
                }),
            ),
        ),
    );

    return Response.redirect(`/?share=${id}`, 303);
}

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    if (
        event.request.method === "POST" &&
        url.origin === self.location.origin &&
        url.pathname === "/share"
    ) {
        event.respondWith(receiveShare(event.request));

        return;
    }

    if (event.request.method !== "GET" || url.origin !== self.location.origin) {
        return;
    }

    if (
        event.request.mode === "navigate" &&
        (url.pathname === "/" || url.pathname.startsWith("/s/"))
    ) {
        event.respondWith(
            (async () => {
                let response;

                try {
                    response = await fetch(event.request);

                    if (response.status < 500) {
                        return response;
                    }
                } catch {
                    // The server is unreachable; use the standalone shell.
                }

                const cache = await caches.open(OFFLINE_CACHE);

                return (await cache.match("/offline.html")) ?? response ?? Response.error();
            })(),
        );

        return;
    }

    if (OFFLINE_ASSETS.includes(url.pathname) && !url.search) {
        event.respondWith(
            (async () => {
                let response;

                try {
                    response = await fetch(event.request);

                    if (response.status < 500) {
                        return response;
                    }
                } catch {
                    // The server is unreachable; use the installed shell asset.
                }

                const cache = await caches.open(OFFLINE_CACHE);

                return (await cache.match(url.pathname)) ?? response ?? Response.error();
            })(),
        );
    }
});
