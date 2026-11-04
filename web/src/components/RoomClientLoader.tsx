"use client";

import dynamic from "next/dynamic";

/**
 * The room screen depends entirely on browser-only things (the socket
 * connection, sessionStorage, window.location), so we skip server rendering
 * for it. `ssr: false` is only allowed inside a Client Component, which is
 * why this small wrapper exists.
 */
export const RoomClientLoader = dynamic(() => import("./RoomClient").then((m) => m.RoomClient), {
  ssr: false,
  loading: () => <p className="p-10 text-lg text-graphite">Opening the room…</p>,
});
