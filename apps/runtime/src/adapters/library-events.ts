import { DurableObject } from "cloudflare:workers";

/**
 * Holds the dashboard's live connections so a server-side change can reach an
 * open tab.
 *
 * The problem this solves: bookmarks are organized by a queue consumer that
 * runs minutes after the capture, in a different isolate. Nothing in the tab is
 * party to that write, so the counts it is showing quietly go out of date and
 * there is no event to listen for. A browser can only close that gap by asking
 * repeatedly or by being told; this is the being-told half. A Durable Object is
 * what makes it possible at all — it is the one thing addressable from another
 * isolate that can also hold a socket open.
 *
 * There is exactly one instance, addressed by a fixed name. This is a
 * single-user application, so a room per deployment is the whole model.
 */
export class LibraryEvents extends DurableObject<Env> {
  /**
   * Hibernatable WebSockets: the runtime keeps the sockets and evicts this
   * object from memory between messages, so an idle dashboard tab costs no
   * duration. Holding them in a field instead would keep the object resident
   * for as long as anyone had the page open.
   */
  override fetch(request: Request): Response {
    const url = new URL(request.url);

    if (url.pathname === "/notify") {
      const payload = JSON.stringify({ type: "library-changed", at: Date.now() });
      let delivered = 0;
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(payload);
          delivered += 1;
        } catch {
          // A socket that has gone away is not a reason to fail the write that
          // triggered this, nor to skip the sockets after it.
        }
      }
      return Response.json({ ok: true, delivered });
    }

    if (url.pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      if (client === undefined || server === undefined) {
        return new Response("WebSocket unavailable", { status: 500 });
      }
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * The dashboard sends nothing but keepalives. Answering them is what stops an
   * idle connection being closed by an intermediary.
   */
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string" && message === "ping") {
      try {
        socket.send(JSON.stringify({ type: "pong" }));
      } catch {
        // Nothing to do: the next broadcast will drop a dead socket anyway.
      }
    }
  }

  /** Removes a closed WebSocket from the live-client set. */
  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    // 1006 is what a browser reports when a tab is closed mid-connection, and
    // is not a valid code to echo back.
    try {
      socket.close(code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }
}

/** One room per deployment, so producers and consumers agree without config. */
export function libraryEventsStub(env: Env): DurableObjectStub {
  return env.LIBRARY_EVENTS.get(env.LIBRARY_EVENTS.idFromName("library"));
}

/**
 * Announces that the library changed. Never throws: a failed notification must
 * not fail the job whose success it is reporting — the dashboard still catches
 * up when the tab is next focused.
 */
export async function notifyLibraryChanged(env: Env): Promise<void> {
  try {
    await libraryEventsStub(env).fetch("https://library-events/notify", { method: "POST" });
  } catch {
    // Best effort by design.
  }
}
