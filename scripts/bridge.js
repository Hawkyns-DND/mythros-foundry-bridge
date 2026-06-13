/**
 * MythrOS Foundry Bridge — Phase 3 relay (client/GM-browser side).
 *
 * Mirrors chat + dice rolls between this Foundry world and the MythrOS Discord
 * session in BOTH directions:
 *
 *   Foundry → Discord : the `createChatMessage` hook POSTs each public message to
 *                       the MythrOS web app (`/api/v1/foundry/relay`).
 *   Discord → Foundry : a WebSocket to `/api/v1/foundry/socket` receives Discord
 *                       chat and creates a matching ChatMessage here.
 *
 * Echo-loop guards:
 *   - Messages we inject from Discord carry `flags.mythros.relayed = true`; the
 *     outbound hook skips anything carrying it.
 *   - Only the PRIMARY active GM relays/injects, so N open clients don't multiply
 *     a single message into N copies.
 *
 * Privacy: GM whispers / blind / self rolls (anything with a whisper target or the
 * blind flag) are never sent to Discord. The server also re-checks roll_mode.
 */

const MOD = "mythros-foundry-bridge";

function S(key) {
  return game.settings.get(MOD, key);
}

/** Only the one canonical active GM acts, so relays/injections aren't duplicated. */
function isPrimaryGM() {
  return game.user?.isGM && game.users?.activeGM?.id === game.user?.id;
}

/** Strip HTML to a plain single line for Discord. */
function toPlainText(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || "").replace(/\s+/g, " ").trim();
}

// ── Settings ────────────────────────────────────────────────────────────────
Hooks.once("init", () => {
  game.settings.register(MOD, "webBaseUrl", {
    name: "MythrOS web base URL",
    hint: "e.g. https://kottrpg.com — the MythrOS web app that fronts the relay.",
    scope: "world", config: true, type: String, default: "https://kottrpg.com",
  });
  game.settings.register(MOD, "sharedSecret", {
    name: "Bridge shared secret",
    hint: "Must equal FOUNDRY_BRIDGE_SECRET on the bot/web. Keep it private.",
    scope: "world", config: true, type: String, default: "",
  });
  game.settings.register(MOD, "gmDiscordId", {
    name: "GM Discord user ID",
    hint: "The Discord user id of the GM running sessions. Routes relays to that GM's live session channel.",
    scope: "world", config: true, type: String, default: "",
  });
  game.settings.register(MOD, "relayEnabled", {
    name: "Enable relay",
    hint: "Master switch for both directions.",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "relayRolls", {
    name: "Relay dice rolls",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "relayChat", {
    name: "Relay chat messages",
    scope: "world", config: true, type: Boolean, default: true,
  });
});

// ── Foundry → Discord ─────────────────────────────────────────────────────────
Hooks.on("createChatMessage", async (message) => {
  try {
    if (!S("relayEnabled") || !isPrimaryGM()) return;
    // Skip anything we ourselves injected from Discord (loop guard).
    if (message.flags?.mythros?.relayed) return;

    const isRoll = (message.rolls?.length ?? 0) > 0 || message.isRoll;
    if (isRoll && !S("relayRolls")) return;
    if (!isRoll && !S("relayChat")) return;

    // Privacy: never leak GM whispers / blind / self rolls into the player channel.
    const isPrivate = !!message.blind || (message.whisper?.length ?? 0) > 0;
    if (isPrivate) return;

    const secret = S("sharedSecret");
    const gmId = S("gmDiscordId");
    const base = (S("webBaseUrl") || "").replace(/\/+$/, "");
    if (!secret || !gmId || !base) return;

    const speaker = message.alias || message.speaker?.alias || "Unknown";
    const body = {
      gm_id: Number(gmId),
      speaker,
      content: toPlainText(message.content),
      is_roll: !!isRoll,
      roll_total: isRoll ? (message.rolls?.[0]?.total ?? null) : null,
      flavor: toPlainText(message.flavor || ""),
      roll_mode: isPrivate ? "gmroll" : null,
      scene: canvas?.scene?.name || null,
    };

    await fetch(`${base}/api/v1/foundry/relay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`${MOD} | Foundry→Discord relay failed`, err);
  }
});

// ── Account bridge: provisioning ops (executed by the primary GM client) ───────
// MythrOS web sends {id, op, args}; we run the Foundry-side change and reply.
// Accounts are created PASSWORDLESS — the member sets their password on first login.
async function handleProvisionOp(op, args) {
  switch (op) {
    case "ensure_user": {
      const name = String(args.login || "Adventurer");
      let user = (game.users.getName?.(name)) || game.users.find((u) => u.name === name);
      if (!user) user = await User.create({ name, role: args.role ?? 1, password: "" });
      return { userId: user.id };
    }
    case "create_actor": {
      const actorData = foundry.utils.duplicate(args.actor || {});
      if (args.owner) {
        actorData.ownership = Object.assign(actorData.ownership || {}, { [args.owner]: 3 }); // 3 = OWNER
      }
      const actor = await Actor.create(actorData);
      return { actorId: actor.id };
    }
    case "reset_password": {
      const u = game.users.get(args.userId);
      if (u) await u.update({ password: "" }); // cleared → member sets it on next login
      return {};
    }
    case "set_role": {
      const u = game.users.get(args.userId);
      if (u) await u.update({ role: args.role });
      return {};
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

// ── Discord → Foundry (WebSocket) ──────────────────────────────────────────────
let _ws = null;
let _reconnectTimer = null;

function connectSocket() {
  if (!isPrimaryGM() || !S("relayEnabled")) return;
  const secret = S("sharedSecret");
  const gmId = S("gmDiscordId");
  const base = (S("webBaseUrl") || "").replace(/\/+$/, "");
  if (!secret || !gmId || !base) return;

  const wsBase = base.replace(/^http/, "ws");
  const url = `${wsBase}/api/v1/foundry/socket?secret=${encodeURIComponent(secret)}&gm=${encodeURIComponent(gmId)}`;

  try {
    _ws = new WebSocket(url);
  } catch (err) {
    console.warn(`${MOD} | socket open failed`, err);
    scheduleReconnect();
    return;
  }

  _ws.addEventListener("open", () => console.log(`${MOD} | bridge socket connected`));
  _ws.addEventListener("close", scheduleReconnect);
  _ws.addEventListener("error", () => { try { _ws.close(); } catch (e) {} });
  _ws.addEventListener("message", async (ev) => {
    try {
      const data = JSON.parse(ev.data);

      // Account-bridge provisioning op: {id, op, args} → reply {id, ok, result|error}.
      // Rides the same socket as relay; only the canonical GM (with create rights) acts.
      if (data.op) {
        if (!isPrimaryGM()) return;
        let reply;
        try {
          reply = { id: data.id, ok: true, result: await handleProvisionOp(data.op, data.args || {}) };
        } catch (e) {
          reply = { id: data.id, ok: false, error: String(e?.message || e) };
        }
        try { _ws.send(JSON.stringify(reply)); } catch (e) {}
        return;
      }

      if (data.origin !== "discord") return;
      if (!isPrimaryGM()) return; // only the canonical GM injects, once
      const speaker = (data.speaker || "Discord").slice(0, 80);
      // flags.mythros.relayed → the outbound hook will skip this, no bounce-back.
      await ChatMessage.create({
        content: foundry.utils.escapeHTML ? foundry.utils.escapeHTML(data.content || "") : (data.content || ""),
        speaker: { alias: `${speaker} (Discord)` },
        flags: { mythros: { relayed: true } },
      });
    } catch (err) {
      console.warn(`${MOD} | Discord→Foundry inject failed`, err);
    }
  });
}

function scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connectSocket();
  }, 5000);
}

Hooks.once("ready", () => {
  if (game.user?.isGM) connectSocket();
});
