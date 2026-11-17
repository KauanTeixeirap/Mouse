import type { ClientMsg, ServerMsg } from "../protocol";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "kicked";

export interface MouseSocketCallbacks {
  onStateChange?: (state: ConnectionState) => void;
  onMessage?: (msg: ServerMsg) => void;
  onLatency?: (ms: number) => void;
}

const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 500;
const PING_INTERVAL_MS = 5000;

export function defaultWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export class MouseSocket {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private device: string;
  private wsUrl: string;
  private callbacks: MouseSocketCallbacks;

  private shouldReconnect = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private rafPending = false;
  private moveAccX = 0;
  private moveAccY = 0;
  private moveFracX = 0;
  private moveFracY = 0;
  private state: ConnectionState = "disconnected";

  constructor(
    device: string,
    callbacks: MouseSocketCallbacks = {},
    wsUrl: string = defaultWsUrl(),
  ) {
    this.device = device;
    this.callbacks = callbacks;
    this.wsUrl = wsUrl;
  }

  getState(): ConnectionState {
    return this.state;
  }

  private setState(next: ConnectionState): void {
    if (this.state !== next) {
      this.state = next;
      this.callbacks.onStateChange?.(next);
    }
  }

  connect(token: string): void {
    this.token = token;
    this.shouldReconnect = true;
    this.attempt = 0;
    this.clearReconnectTimer();
    this.openSocket();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearPingTimer();
    if (this.ws) {
      this.ws.close(1000, "client_disconnect");
      this.ws = null;
    }
    this.setState("disconnected");
  }

  takeover(): void {
    if (!this.token) return;
    this.shouldReconnect = true;
    this.attempt = 0;
    this.clearReconnectTimer();
    this.openSocket();
  }

  queueMove(dx: number, dy: number): void {
    this.moveAccX += dx;
    this.moveAccY += dy;
    if (this.rafPending) return;
    this.rafPending = true;
    const schedule =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16);
    schedule(() => {
      this.rafPending = false;
      this.flushMove();
    });
  }

  flushMove(): void {
    const totalX = this.moveAccX + this.moveFracX;
    const totalY = this.moveAccY + this.moveFracY;
    this.moveAccX = 0;
    this.moveAccY = 0;

    const sendX = Math.trunc(totalX);
    const sendY = Math.trunc(totalY);
    this.moveFracX = totalX - sendX;
    this.moveFracY = totalY - sendY;

    if (sendX !== 0 || sendY !== 0) {
      this.send({ t: "move", dx: sendX, dy: sendY });
    }
  }

  send(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private openSocket(): void {
    if (!this.token) return;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.clearPingTimer();
    this.setState("connecting");

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (!this.token) return;
      this.attempt = 0;
      ws.send(JSON.stringify({ t: "hello", token: this.token, device: this.device }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let parsed: ServerMsg;
      try {
        parsed = JSON.parse(event.data) as ServerMsg;
      } catch {
        return;
      }

      if (parsed.t === "welcome") {
        this.setState("connected");
        this.startPingLoop();
      } else if (parsed.t === "kicked") {
        this.shouldReconnect = false;
        this.clearPingTimer();
        this.setState("kicked");
      } else if (parsed.t === "pong") {
        const rtt = Math.max(0, Math.round(performance.now() - parsed.ts));
        this.callbacks.onLatency?.(rtt);
      }

      this.callbacks.onMessage?.(parsed);
    };

    ws.onclose = (event) => {
      this.clearPingTimer();
      this.ws = null;
      if (event.code === 4401) {
        this.shouldReconnect = false;
        this.setState("disconnected");
        this.callbacks.onMessage?.({ t: "error", code: "unauthorized" });
        return;
      }
      if (this.state === "kicked") {
        return;
      }
      this.setState("disconnected");
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose handles reconnection
    };
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, this.attempt));
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPingLoop(): void {
    this.clearPingTimer();
    this.send({ t: "ping", ts: performance.now() });
    this.pingTimer = window.setInterval(() => {
      this.send({ t: "ping", ts: performance.now() });
    }, PING_INTERVAL_MS);
  }

  private clearPingTimer(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
