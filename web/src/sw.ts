const CACHE_NAME = "mouse-pwa-v2";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-192.svg",
  "/icon-512.svg",
];

interface SwEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface SwFetchEvent extends SwEvent {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

interface SwScope {
  addEventListener(type: "install" | "activate", listener: (e: SwEvent) => void): void;
  addEventListener(type: "fetch", listener: (e: SwFetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
}

const sw = globalThis as unknown as SwScope;

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", clone));
          return res;
        })
        .catch(async () => {
          const cached = await caches.match("/index.html");
          return cached ?? new Response("Offline", { status: 503 });
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached ?? new Response("", { status: 504 }));

      return cached ?? networkFetch;
    }),
  );
});
