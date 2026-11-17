import type { Settings } from "./protocol";

const TOKEN_STORAGE_KEY = "mouse_token";
const DEVICE_STORAGE_KEY = "mouse_device_name";

export interface PairSuccessResponse {
  token: string;
  active_profile: string;
  settings: Settings;
  profiles: string[];
}

export function extractQrCodeFromHash(hash: string): string | null {
  const clean = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!clean) return null;
  const params = new URLSearchParams(clean);
  const code = params.get("pair");
  return code && code.trim().length > 0 ? code.trim() : null;
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveStoredToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore storage failures
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

export function getOrCreateDeviceName(): string {
  try {
    const existing = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (existing && existing.trim()) return existing;
    const ua = navigator.userAgent;
    const match = ua.match(/Android[^;)]*;\s*([^)]+)\)/i);
    const derived = match?.[1]?.split(";").pop()?.trim() || "Android Chrome";
    const clean = derived.slice(0, 60);
    localStorage.setItem(DEVICE_STORAGE_KEY, clean);
    return clean;
  } catch {
    return "Android Chrome";
  }
}

export async function pairWithServer(
  method: "qr" | "pin",
  code: string,
  device: string,
  fetchFn: typeof fetch = fetch,
): Promise<PairSuccessResponse> {
  const resp = await fetchFn("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, code: code.trim(), device }),
  });
  if (!resp.ok) {
    let message = "Código ou PIN inválido ou expirado";
    try {
      const body = (await resp.json()) as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // ignore json parse errors
    }
    throw new Error(message);
  }
  const data = (await resp.json()) as PairSuccessResponse;
  saveStoredToken(data.token);
  return data;
}
