import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLock, atomicJson, readJson } from "./storage.js";
import type { Model } from "./types.js";
import type { ProviderFailure } from "./providers.js";

export type CircuitState = "closed" | "open" | "half-open";
/** Longer than the provider client's 120s request deadline, but never permanent. */
export const RECOVERY_PROBE_MS = 130_000;
interface Probe {
  id: string;
  owner: string;
  model: string;
  expiresAt: number;
}
interface Gate {
  failures: number;
  until: number;
  reason: string;
  state?: CircuitState;
  generation?: string;
  probe?: Probe;
}
interface Pool {
  minuteStart: number;
  minuteRequests: number;
  day: string;
  dayRequests: number;
  attempts: number;
}
interface RoutingState {
  gates: Record<string, Gate>;
  pools: Record<string, Pool>;
}
interface Availability {
  available: boolean;
  reason?: string;
  retryAt?: number;
  state?: CircuitState;
}
interface Reservation {
  expiresAt: number;
  ambiguous: boolean;
  probes: Record<string, { id: string; generation?: string }>;
}

export class Router {
  private readonly owner = randomUUID();
  private readonly reservations = new Map<string, Reservation[]>();
  constructor(
    private home: string,
    private now = Date.now,
    private random = Math.random,
  ) {}
  private file() {
    return path.join(this.home, "routing.json");
  }
  status(): RoutingState {
    const state = readJson<RoutingState>(this.file(), { gates: {}, pools: {} });
    // Lazy recovery also upgrades existing cooldown-only records. Reading status
    // makes expired gates visibly probe-ready without mutating the persisted file.
    for (const gate of Object.values(state.gates)) {
      if (gate.state === "closed") continue;
      gate.state = gate.until > this.now() ? "open" : "half-open";
      if (gate.probe && gate.probe.expiresAt <= this.now()) delete gate.probe;
    }
    return state;
  }
  private async change<T>(fn: (state: RoutingState) => T): Promise<T> {
    let release: (() => void) | undefined;
    for (let i = 0; i < 50; i++) {
      try {
        release = acquireLock(path.join(this.home, "locks", "routing"));
        break;
      } catch (error) {
        if (i === 49) throw error;
        await delay(20);
      }
    }
    try {
      const state = this.status();
      const result = fn(state);
      atomicJson(this.file(), state);
      return result;
    } finally {
      release?.();
    }
  }
  private modelKey(model: Model): string {
    return `${model.provider}/${model.id}`;
  }
  private keys(model: Model): string[] {
    return [
      `provider:${model.provider}`,
      `account:${model.provider}`,
      `pool:${model.provider}:${model.pool}`,
      `model:${model.provider}:${model.id}`,
    ];
  }
  private available(state: RoutingState, model: Model): Availability {
    const now = this.now();
    let recovery = false;
    let blocked: Availability | undefined;
    for (const key of this.keys(model)) {
      const gate = state.gates[key];
      if (!gate || gate.state === "closed") continue;
      if (gate.until > now) {
        if (!blocked || gate.until > (blocked.retryAt ?? 0)) {
          blocked = {
            available: false,
            reason: gate.reason,
            retryAt: gate.until,
            state: "open",
          };
        }
      } else if (gate.probe && gate.probe.expiresAt > now) {
        if (!blocked || gate.probe.expiresAt > (blocked.retryAt ?? 0)) {
          blocked = {
            available: false,
            reason: `${gate.reason}; one recovery probe is already running`,
            retryAt: gate.probe.expiresAt,
            state: "half-open",
          };
        }
      } else recovery = true;
    }
    const quotaBlocks: Availability[] = [];
    if (model.provider === "openrouter") {
      const pool = state.pools["openrouter:free-account"];
      if (pool) {
        if (pool.minuteStart + 60_000 > now && pool.minuteRequests >= 20)
          quotaBlocks.push({
            available: false,
            reason: "Shared OpenRouter free requests per minute",
            retryAt: pool.minuteStart + 60_000,
          });
        if (
          pool.day === new Date(now).toISOString().slice(0, 10) &&
          pool.dayRequests >= 50
        )
          quotaBlocks.push({
            available: false,
            reason:
              "Conservative shared OpenRouter daily allowance (50 requests)",
            retryAt: Date.parse(pool.day) + 86_400_000,
          });
      }
    }
    for (const quota of quotaBlocks) {
      if (!blocked || (quota.retryAt ?? 0) > (blocked.retryAt ?? 0))
        blocked = quota;
    }
    return (
      blocked ?? { available: true, state: recovery ? "half-open" : "closed" }
    );
  }
  availability(model: Model): Availability {
    return this.available(this.status(), model);
  }
  private activeReservations(model: Model): Reservation[] {
    const key = this.modelKey(model);
    const records = (this.reservations.get(key) ?? []).filter(
      (record) => record.expiresAt > this.now(),
    );
    if (records.length) this.reservations.set(key, records);
    else this.reservations.delete(key);
    return records;
  }
  private finish(model: Model): Reservation | undefined {
    const records = this.activeReservations(model);
    const record = records.shift();
    if (records.length) this.reservations.set(this.modelKey(model), records);
    else this.reservations.delete(this.modelKey(model));
    return record;
  }
  async reserve(model: Model): Promise<boolean> {
    return this.change((state) => {
      // Availability and quota/probe reservation use the SAME locked snapshot.
      // Two processes cannot both enter an expired provider or shared account gate.
      if (!this.available(state, model).available) return false;
      const now = this.now();
      const record: Reservation = {
        expiresAt: now + RECOVERY_PROBE_MS,
        ambiguous: false,
        probes: {},
      };
      for (const key of this.keys(model)) {
        const gate = state.gates[key];
        if (!gate || gate.state === "closed") continue;
        gate.state = "half-open";
        gate.generation ??= randomUUID();
        gate.probe = {
          id: randomUUID(),
          owner: this.owner,
          model: this.modelKey(model),
          expiresAt: record.expiresAt,
        };
        record.probes[key] = { id: gate.probe.id, generation: gate.generation };
      }
      const records = this.activeReservations(model);
      // This API deliberately has no request token. Concurrent same-model calls
      // cannot safely associate out-of-order results with reservations, so none
      // of that overlapping group is allowed to close a circuit.
      if (records.length) {
        record.ambiguous = true;
        for (const existing of records) existing.ambiguous = true;
      }
      records.push(record);
      this.reservations.set(this.modelKey(model), records);
      const key =
        model.provider === "openrouter"
          ? "openrouter:free-account"
          : `${model.provider}:${model.pool}`;
      const day = new Date(now).toISOString().slice(0, 10);
      const pool = state.pools[key] ?? {
        minuteStart: now,
        minuteRequests: 0,
        day,
        dayRequests: 0,
        attempts: 0,
      };
      if (pool.minuteStart + 60_000 <= now) {
        pool.minuteStart = now;
        pool.minuteRequests = 0;
      }
      if (pool.day !== day) {
        pool.day = day;
        pool.dayRequests = 0;
      }
      pool.minuteRequests++;
      pool.dayRequests++;
      pool.attempts++;
      state.pools[key] = pool;
      return true;
    });
  }
  private owns(
    gate: Gate,
    record: Reservation | undefined,
    key: string,
  ): boolean {
    const reserved = record?.probes[key];
    return Boolean(
      reserved &&
      !record?.ambiguous &&
      gate.probe?.owner === this.owner &&
      gate.probe.id === reserved.id &&
      gate.generation === reserved.generation &&
      gate.probe.expiresAt > this.now(),
    );
  }
  async failure(model: Model, error: ProviderFailure): Promise<void> {
    await this.change((state) => {
      const record = this.finish(model);
      // A reported cancellation/invalid request releases its own recovery lease,
      // without classifying a provider failure or initiating any fallback.
      for (const key of this.keys(model)) {
        const gate = state.gates[key];
        if (gate && this.owns(gate, record, key)) {
          delete gate.probe;
          gate.state = "half-open";
        }
      }
      if (error.cancelled || !error.recoverable || error.scope === "request")
        return;
      const key =
        error.scope === "model"
          ? `model:${model.provider}:${model.id}`
          : error.scope === "account"
            ? `account:${model.provider}`
            : `provider:${model.provider}`;
      const old = state.gates[key];
      // Concurrent failures neither shorten Retry-After nor repeatedly extend it.
      if (old && old.state !== "closed" && old.until > this.now()) return;
      const failures = (old?.failures ?? 0) + 1;
      const backoff = Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6));
      const hint = error.retryAfterMs;
      const duration =
        hint !== undefined && Number.isFinite(hint) && hint >= 0
          ? hint
          : error.status === 401 || error.status === 403 || error.status === 402
            ? 86_400_000
            : Math.round(backoff * (0.8 + this.random() * 0.4));
      state.gates[key] = {
        failures,
        until: this.now() + Math.max(500, duration),
        reason: `${error.scope}: ${error.message}`,
        state: "open",
        generation: randomUUID(),
      };
    });
  }
  async success(model: Model): Promise<void> {
    await this.change((state) => {
      const record = this.finish(model);
      for (const key of this.keys(model)) {
        const gate = state.gates[key];
        if (!gate || !this.owns(gate, record, key)) continue;
        // Only the still-current exclusive probe can close its own generation.
        // A success from an earlier request cannot erase a newer failure gate,
        // even if that newer gate's cooldown has elapsed in the meantime.
        state.gates[key] = {
          failures: 0,
          until: 0,
          reason: "Recovery probe succeeded",
          state: "closed",
          generation: gate.generation,
        };
      }
    });
  }
  async resetAccount(provider: string): Promise<void> {
    await this.change((state) => {
      delete state.gates[`account:${provider}`];
    });
  }
}
