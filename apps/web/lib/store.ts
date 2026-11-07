"use client";
import type { Address } from "viem";
import type { SerializedKey } from "@lifeboat/pq-signer";

/**
 * Safe-style local persistence: remember the vaults a signer has created/added, and cache
 * the PQ keyfile for a seamless session. The keyfile holds the PQ master seed — for a real
 * product this would be the user's downloaded "recovery kit", not localStorage; we cache it
 * for demo convenience AND prompt a download on creation.
 */
export interface VaultRef {
  address: Address;
  chainId: number;
  label: string;
}

const VAULTS_KEY = "lifeboat.vaults";
const keyKey = (addr: Address) => `lifeboat.key.${addr.toLowerCase()}`;

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function listVaults(): VaultRef[] {
  const raw = safeGet(VAULTS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as VaultRef[];
  } catch {
    return [];
  }
}

export function addVault(v: VaultRef): VaultRef[] {
  const existing = listVaults().filter(
    (x) => !(x.address.toLowerCase() === v.address.toLowerCase() && x.chainId === v.chainId),
  );
  const next = [v, ...existing];
  window.localStorage.setItem(VAULTS_KEY, JSON.stringify(next));
  return next;
}

export function removeVault(address: Address, chainId: number): VaultRef[] {
  const next = listVaults().filter(
    (x) => !(x.address.toLowerCase() === address.toLowerCase() && x.chainId === chainId),
  );
  window.localStorage.setItem(VAULTS_KEY, JSON.stringify(next));
  return next;
}

export function cacheKey(address: Address, key: SerializedKey): void {
  try {
    window.localStorage.setItem(keyKey(address), JSON.stringify(key));
  } catch {
    /* ignore quota errors */
  }
}

export function loadKey(address: Address): SerializedKey | null {
  const raw = safeGet(keyKey(address));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SerializedKey;
  } catch {
    return null;
  }
}

/** Trigger a browser download of the PQ keyfile — the "recovery kit". */
export function downloadKeyfile(address: Address, key: SerializedKey): void {
  const blob = new Blob([JSON.stringify(key, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lifeboat-${address.slice(0, 10)}.key.json`;
  a.click();
  URL.revokeObjectURL(url);
}
