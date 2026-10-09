import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotContext } from "../src/core/types.js";

const { fetchSteam, save, members, send, enabled } = vi.hoisted(() => ({
  fetchSteam: vi.fn(), save: vi.fn(), members: vi.fn(), send: vi.fn(), enabled: { value: true },
}));
vi.mock("node:fs", () => ({ readFileSync: () => JSON.stringify({ "10": { "765": { name: "test", online: false, game: "" } } }) }));
vi.mock("../src/core/user_mapping.js", () => ({ getUserMapping: () => ({ steam_ids: ["765"] }) }));
vi.mock("../plugins/steam/shared.js", () => ({
  areSteamNotificationsEnabled: () => enabled.value, escapeOneBotText: (s: string) => s,
  fetchSteam, isSteamApiError: () => false, sanitizeExternalText: (s: string) => s,
  STEAM_STATE_FILE: "synthetic-state", loadSteamSubscriptions: () => ({ "10": { status: true } }),
  steamIdsFromMapping: () => ["765"], writeSecureJson: save,
}));
import { forceRefresh, initWatcher, stopWatcher } from "../plugins/steam/watcher.js";

const response = { response: { players: [{ steamid: "765", personaname: "test", personastate: 1 }] } };
function deferredFetch(): () => void {
  let release!: () => void;
  fetchSteam.mockImplementation(() => new Promise(resolve => { release = () => resolve(response); }));
  return () => release();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  enabled.value = true;
  members.mockResolvedValue([{ qq: 123 }]); send.mockResolvedValue(undefined);
  const ctx = { config: { steamWatcher: { intervalMinutes: 5 } }, adapter: { getGroupMembers: members }, sendMessage: send,
    logger: { warn: vi.fn() } } as unknown as BotContext;
  initWatcher(ctx, "synthetic-key");
});
afterEach(() => { stopWatcher(); vi.useRealTimers(); });

describe("Steam watcher lifecycle", () => {
  it("shares one collection between timer and simultaneous manual refreshes", async () => {
    const release = deferredFetch();
    await vi.advanceTimersByTimeAsync(300_000);
    const first = forceRefresh(10);
    const second = forceRefresh(10);
    expect(members).toHaveBeenCalledTimes(1);
    expect(fetchSteam).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not write state or notify after stopping an in-flight collection", async () => {
    const release = deferredFetch();
    const pending = forceRefresh(10);
    await Promise.resolve();
    expect(fetchSteam).toHaveBeenCalledTimes(1);
    stopWatcher();
    release(); await pending;
    expect(save).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("advances the baseline but suppresses notifications when disabled during collection", async () => {
    const release = deferredFetch();
    const pending = forceRefresh(10);
    await Promise.resolve();
    enabled.value = false;
    release(); await pending;
    expect(save).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
