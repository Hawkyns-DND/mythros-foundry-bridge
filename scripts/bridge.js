/**
 * MythrOS Foundry Bridge — relay + sync + combat augmentation (client/GM-browser side).
 *
 * Phase A combat augmentation (this build): hidden monster HP, async turn-prep
 * declarations, and permadeath, layered on the dnd5e engine (Foundry-local; Phase B
 * wires these two-way to Discord).
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

// Shared starter password every new login is created with; the member is forced to
// replace it on first login (see enforcePasswordChange). Must match the bot's
// foundry_account_service.STARTER_PASSWORD.
const STARTER_PASSWORD = "KoTTrpg";

// dnd5e item types that define a character's identity/progression — players may not
// add, remove, or re-level these (MythrOS owns them). Spells/gear/feats are fine.
const PLAYER_LOCKED_ITEM_TYPES = new Set(["class", "subclass", "race", "background"]);

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
  game.settings.register(MOD, "syncEconomy", {
    name: "Sync economy from MythrOS",
    hint: "On session start, pull each bridged actor's gold from MythrOS (the economy authority).",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "combatModule", {
    name: "MythrOS combat augmentation",
    hint: "Layer the MythrOS combat feel on dnd5e: hidden monster HP, turn-prep declarations, and permadeath. Master switch for the combat features.",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "hideNpcHp", {
    name: "Hide monster HP from players",
    hint: "When a combat starts, set non-PC token bars to GM-only so players can't read monster HP.",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "lockPlayerSheets", {
    name: "Lock core character fields",
    hint: "Players keep their actor but can't edit MythrOS-owned fields (name, abilities, level, class/race, max HP, AC, proficiencies). Notes, spell prep, and inventory stay editable.",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "showBrand", {
    name: "Show KoTTrpg mark",
    hint: "A small breathing KoTTrpg wordmark in the top-left corner. Per-player; turn it off here.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => injectBrand(),
  });
});

/** Pin (or remove) the breathing KoTTrpg wordmark in the top-left. */
function injectBrand() {
  const existing = document.getElementById("kottrpg-brand");
  if (!S("showBrand")) { existing?.remove(); return; }
  if (existing) return;
  const el = document.createElement("div");
  el.id = "kottrpg-brand";
  el.innerHTML = `Ko<span class="kott-accent">TT</span>rpg`;
  el.title = "KoTTrpg / Ashreach";
  document.body.appendChild(el);
}

// ── Phase 2 live sync ─────────────────────────────────────────────────────────
// Combat state (HP / temp / death saves) is pushed Foundry → MythrOS as it changes;
// economy (gold) is pulled MythrOS → Foundry on session start. Only the primary GM
// acts, and only for actors carrying flags.mythros.characterId.

// Foundry → MythrOS: HP / death-save changes.
Hooks.on("updateActor", async (actor, changes) => {
  try {
    if (!S("relayEnabled") || !isPrimaryGM()) return;
    const cid = actor.flags?.mythros?.characterId;
    if (!cid) return;
    // Only push when an HP or death-save field actually changed.
    const hpChanged = changes.system?.attributes?.hp !== undefined;
    const deathChanged = changes.system?.attributes?.death !== undefined;
    if (!hpChanged && !deathChanged) return;

    const secret = S("sharedSecret");
    const base = (S("webBaseUrl") || "").replace(/\/+$/, "");
    if (!secret || !base) return;

    const attrs = actor.system?.attributes || {};
    await fetch(`${base}/api/v1/foundry/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
      body: JSON.stringify({
        character_id: Number(cid),
        hp_current: attrs.hp?.value ?? null,
        hp_temp: attrs.hp?.temp ?? null,
        death_successes: attrs.death?.success ?? null,
        death_failures: attrs.death?.failure ?? null,
      }),
    });
  } catch (err) {
    console.warn(`${MOD} | combat sync (Foundry→MythrOS) failed`, err);
  }
});

// MythrOS → Foundry: pull authoritative gold for every bridged actor on session start.
async function pullEconomy() {
  if (!isPrimaryGM() || !S("syncEconomy")) return;
  const secret = S("sharedSecret");
  const base = (S("webBaseUrl") || "").replace(/\/+$/, "");
  if (!secret || !base) return;
  for (const actor of game.actors) {
    const cid = actor.flags?.mythros?.characterId;
    if (!cid) continue;
    try {
      const res = await fetch(`${base}/api/v1/foundry/actor/${Number(cid)}`, {
        headers: { "Authorization": `Bearer ${secret}` },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const gp = data?.system?.currency?.gp;
      // Setting currency fires updateActor, but our hook above only pushes on
      // HP/death changes, so this never loops back into a sync.
      if (typeof gp === "number" && gp !== actor.system?.currency?.gp) {
        await actor.update({ "system.currency.gp": gp });
      }
    } catch (err) {
      console.warn(`${MOD} | economy pull failed for actor`, cid, err);
    }
  }
}
Hooks.once("ready", () => { if (game.user?.isGM) pullEconomy(); });

// ── Phase A — MythrOS combat augmentation ──────────────────────────────────────
// Hidden monster HP, async turn-prep declarations, and permadeath, layered on the
// dnd5e engine. Foundry-local in Phase A; Phase B syncs these to Discord.

const DEATH_FAILS_FATAL = 3;

// True while we're applying a Discord-driven snapshot to Foundry, so our own
// outbound combat hooks skip those changes (no echo back to MythrOS).
let _applyingDiscord = false;

function combatEnabled() {
  return S("combatModule");
}

/** Hide non-PC token HP bars from players when a combat begins (primary GM only). */
async function hideMonsterHp(combat) {
  if (!combatEnabled() || !S("hideNpcHp") || !isPrimaryGM()) return;
  const ownerOnly = CONST.TOKEN_DISPLAY_MODES.OWNER;
  for (const c of combat?.combatants ?? []) {
    const token = c.token;   // TokenDocument
    const actor = c.actor;
    if (!token || !actor || actor.type === "character") continue;
    if (token.displayBars === ownerOnly) continue;
    try { await token.update({ displayBars: ownerOnly }); } catch (e) { /* best-effort */ }
  }
}

Hooks.on("combatStart", (combat) => hideMonsterHp(combat));
Hooks.on("createCombat", (combat) => hideMonsterHp(combat));

// Turn-prep: when the active turn lands on a PC you own, prompt a declaration.
let _lastPrepKey = null;
Hooks.on("updateCombat", async (combat, changes) => {
  try {
    if (!combatEnabled()) return;
    if (changes.turn === undefined && changes.round === undefined) return;
    const c = combat.combatant;
    const actor = c?.actor;
    if (!actor || actor.type !== "character" || !actor.isOwner) return;
    if (game.user.isGM) return; // players declare; the GM runs the table
    const key = `${combat.id}:${combat.round}:${combat.turn}`;
    if (_lastPrepKey === key) return; // one prompt per turn
    _lastPrepKey = key;
    await promptTurnPrep(combat, c);
  } catch (err) {
    console.warn(`${MOD} | turn-prep prompt failed`, err);
  }
});

async function promptTurnPrep(combat, combatant) {
  const field = (name, label, ph) =>
    `<div class="form-group"><label>${label}</label><input type="text" name="${name}" placeholder="${ph}"/></div>`;
  const content = `
    <p>It's <strong>${combatant.name}</strong>'s turn. Declare your intent (optional):</p>
    ${field("movement", "Movement", "where you move")}
    ${field("action", "Action", "attack / cast / dash …")}
    ${field("bonus_action", "Bonus action", "off-hand / spell …")}
    ${field("target", "Target", "who / what")}
    ${field("notes", "Notes", "anything else")}`;
  const prep = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Declare your turn", icon: "fa-solid fa-clipboard-list" },
    content,
    ok: { label: "Declare", callback: (_e, btn) => {
      const f = btn.form;
      return {
        movement: f.movement.value.trim(),
        action: f.action.value.trim(),
        bonus_action: f.bonus_action.value.trim(),
        target: f.target.value.trim(),
        notes: f.notes.value.trim(),
      };
    } },
  }).catch(() => null);
  if (!prep) return;
  try { await combatant.setFlag(MOD, "turnPrep", prep); } catch (e) { /* best-effort */ }
  const lines = [
    prep.movement && `<strong>Move:</strong> ${prep.movement}`,
    prep.action && `<strong>Action:</strong> ${prep.action}`,
    prep.bonus_action && `<strong>Bonus:</strong> ${prep.bonus_action}`,
    prep.target && `<strong>Target:</strong> ${prep.target}`,
    prep.notes && `<strong>Notes:</strong> ${prep.notes}`,
  ].filter(Boolean);
  if (!lines.length) return;
  await ChatMessage.create({
    speaker: { alias: `${combatant.name} — turn declaration` },
    content: `<div class="mythros-turn-prep">${lines.join("<br>")}</div>`,
  });
}

// Permadeath: a bridged PC at 3 death-save failures is locked dead (Foundry-local in A).
Hooks.on("updateActor", async (actor, changes) => {
  try {
    if (_applyingDiscord) return;
    if (!combatEnabled() || !isPrimaryGM()) return;
    if (changes.system?.attributes?.death === undefined) return;
    if (actor.type !== "character") return;
    const fails = actor.system?.attributes?.death?.failure ?? 0;
    if (fails < DEATH_FAILS_FATAL) return;
    if (actor.getFlag(MOD, "permadead")) return; // already handled
    await actor.setFlag(MOD, "permadead", true);
    try { await actor.toggleStatusEffect?.("dead", { active: true, overlay: true }); } catch (e) { /* best-effort */ }
    await ChatMessage.create({
      speaker: { alias: "The Ash Remembers" },
      content: `<div class="mythros-permadeath"><h3>☠️ ${actor.name} has fallen.</h3><p>Three death-save failures. The Ash takes them — this death is permanent.</p></div>`,
    });
    // Phase B: write the death through to MythrOS (permadeath in the bot DB).
    postCombat("permadeath", { name: actor.name });
  } catch (err) {
    console.warn(`${MOD} | permadeath lock failed`, err);
  }
});

// ── Phase B1 — combat sync (Foundry → MythrOS) ─────────────────────────────────
// The primary GM mirrors the Foundry fight into the bot's live combat tracker by
// POSTing typed events. The bot drives combat_service + posts a line to the in-game
// channel. Combat state only — economy stays MythrOS-authoritative.

async function postCombat(event, payload) {
  if (!combatEnabled() || !isPrimaryGM()) return;
  const secret = S("sharedSecret");
  const gmId = S("gmDiscordId");
  const base = (S("webBaseUrl") || "").replace(/\/+$/, "");
  if (!secret || !gmId || !base) return;
  try {
    await fetch(`${base}/api/v1/foundry/combat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
      body: JSON.stringify({ gm_id: Number(gmId), event, payload }),
    });
  } catch (err) {
    console.warn(`${MOD} | combat sync POST failed`, event, err);
  }
}

/** Serialize a combat's combatants for the bot tracker (name/init/hp/ac/is_player). */
function combatantsPayload(combat) {
  const out = [];
  for (const c of combat?.combatants ?? []) {
    const a = c.actor;
    if (!a) continue;
    const hp = a.system?.attributes?.hp || {};
    out.push({
      name: c.name,
      initiative: Number(c.initiative ?? 0) || 0,
      hp_max: hp.max ?? null,
      is_player: a.type === "character",
      ac: a.system?.attributes?.ac?.value ?? null,
    });
  }
  return out;
}

// Combat start → mirror the tracker.
Hooks.on("combatStart", (combat) => {
  if (_applyingDiscord) return;
  postCombat("combat_start", { combatants: combatantsPayload(combat), hide_npc_hp: S("hideNpcHp") });
});

// Turn / round advance → advance the bot tracker.
Hooks.on("updateCombat", (combat, changes) => {
  if (_applyingDiscord) return;
  if (changes.turn === undefined && changes.round === undefined) return;
  postCombat("turn_advance", { name: combat.combatant?.name || null });
});

// HP change on a combatant in the active fight → mirror it.
Hooks.on("updateActor", (actor, changes) => {
  if (_applyingDiscord) return;
  if (changes.system?.attributes?.hp === undefined) return;
  const combat = game.combats?.active;
  if (!combat?.started) return;
  const inFight = (combat.combatants ?? []).find((c) => c.actor?.id === actor.id);
  if (!inFight) return;
  const hp = actor.system?.attributes?.hp || {};
  postCombat("hp", { name: inFight.name, hp_current: hp.value ?? null, hp_max: hp.max ?? null });
});

// A player's turn-prep declaration (the flag set in Phase A) → relay to Discord.
Hooks.on("updateCombatant", (combatant, changes) => {
  if (_applyingDiscord) return;
  const prep = changes.flags?.mythros?.turnPrep;
  if (!prep) return;
  postCombat("turn_prep", { name: combatant.name, user_id: 0, ...prep });
});

// A combatant added to an already-running fight → mirror it as a reinforcement.
// (Initial combatants are added before "Begin Combat", so combat.started is false
// then and combatStart handles them — this fires only for true mid-fight arrivals.)
Hooks.on("createCombatant", (combatant) => {
  if (_applyingDiscord) return;
  if (!combatant.combat?.started) return;
  const a = combatant.actor;
  const hp = a?.system?.attributes?.hp || {};
  postCombat("combatant_add", {
    combatant: {
      name: combatant.name,
      initiative: Number(combatant.initiative ?? 0) || 0,
      hp_max: hp.max ?? null,
      is_player: a?.type === "character",
      ac: a?.system?.attributes?.ac?.value ?? null,
    },
  });
});

/** POST the defeated NPCs to MythrOS so the bot rolls a claimable loot sheet. */
async function postLoot(encounters) {
  if (!combatEnabled() || !isPrimaryGM()) return;
  const secret = S("sharedSecret");
  const gmId = S("gmDiscordId");
  const base = (S("webBaseUrl") || "").replace(/\/+$/, "");
  if (!secret || !gmId || !base) return;
  try {
    await fetch(`${base}/api/v1/foundry/loot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
      body: JSON.stringify({ gm_id: Number(gmId), encounters }),
    });
  } catch (err) {
    console.warn(`${MOD} | loot POST failed`, err);
  }
}

/** Defeated non-PC combatants grouped by name → [{name, cr, count}] for loot. */
function lootPayload(combat) {
  const groups = new Map();
  for (const c of combat?.combatants ?? []) {
    const a = c.actor;
    if (!a || a.type === "character") continue;
    const hp = a.system?.attributes?.hp?.value;
    const defeated = c.isDefeated || c.defeated || (hp !== undefined && hp !== null && hp <= 0);
    if (!defeated) continue;
    const g = groups.get(a.name) || { name: a.name, cr: Number(a.system?.details?.cr ?? 0) || 0, count: 0 };
    g.count += 1;
    groups.set(a.name, g);
  }
  return [...groups.values()];
}

// Combat ends in Foundry → close the bot tracker (and drop its action buttons), and
// roll a claimable loot sheet from the defeated NPCs (the bot owns loot).
Hooks.on("deleteCombat", (combat) => {
  if (_applyingDiscord) return;
  postCombat("combat_end", {});
  const loot = lootPayload(combat);
  if (loot.length) postLoot(loot);
});

// ── Phase B2 — apply Discord-driven combat state to Foundry ────────────────────
// A snapshot (combatants + current turn + hp_visible) arrives over the WS when the
// table acts on the Discord side; the primary GM applies it to tokens + turn order.

function combatantByName(combat, name) {
  return combat?.combatants?.find((cb) => cb.name === name) || null;
}

/** Resolve the Foundry actor for a snapshot combatant: the in-combat token actor
 *  first (handles unlinked NPCs), then a bridged PC by characterId, then by name. */
function actorForSnapshot(combat, c) {
  const cb = combatantByName(combat, c.name);
  if (cb?.actor) return { actor: cb.actor, combatant: cb };
  if (c.character_id) {
    const a = game.actors.find((x) => Number(x.flags?.mythros?.characterId) === Number(c.character_id));
    if (a) return { actor: a, combatant: null };
  }
  return { actor: game.actors.getName?.(c.name) || null, combatant: null };
}

async function applyDiscordCombat(data) {
  if (!combatEnabled() || !isPrimaryGM()) return;
  _applyingDiscord = true;
  try {
    const combat = game.combats?.active;
    for (const c of data.combatants || []) {
      const { actor, combatant } = actorForSnapshot(combat, c);
      if (actor) {
        const update = {};
        if (c.hp_current !== null && c.hp_current !== undefined) update["system.attributes.hp.value"] = c.hp_current;
        if (c.hp_max !== null && c.hp_max !== undefined) update["system.attributes.hp.max"] = c.hp_max;
        if (c.is_player) {
          if (c.death_failures !== null && c.death_failures !== undefined) update["system.attributes.death.failure"] = c.death_failures;
          if (c.death_successes !== null && c.death_successes !== undefined) update["system.attributes.death.success"] = c.death_successes;
        }
        if (Object.keys(update).length) { try { await actor.update(update); } catch (e) { /* best-effort */ } }
        // Permadeath visual for a PC that died on the Discord side — our own
        // permadeath hook is suppressed by _applyingDiscord, so apply it here.
        if (c.is_player && c.dead && !actor.getFlag(MOD, "permadead")) {
          try {
            await actor.setFlag(MOD, "permadead", true);
            await actor.toggleStatusEffect?.("dead", { active: true, overlay: true });
          } catch (e) { /* best-effort */ }
        }
      }
      // Defeated marker for a fallen combatant. NPCs are 'downed' at 0 HP (never
      // 'dead', which is PC-only), so key off either.
      if (combatant && (c.downed || c.dead) && !combatant.isDefeated) {
        try { await combatant.update({ defeated: true }); } catch (e) { /* best-effort */ }
      }
    }
    // Current turn.
    if (combat?.started && data.current_turn) {
      const cb = combatantByName(combat, data.current_turn);
      const turnIdx = cb ? (combat.turns || []).findIndex((t) => t.id === cb.id) : -1;
      if (turnIdx >= 0 && turnIdx !== combat.turn) { try { await combat.update({ turn: turnIdx }); } catch (e) { /* best-effort */ } }
    }
    // Hidden HP: keep NPC bars GM-only when MythrOS says HP isn't visible.
    if (data.hp_visible === false && combat) await hideMonsterHp(combat);
  } catch (err) {
    console.warn(`${MOD} | applyDiscordCombat failed`, err);
  } finally {
    _applyingDiscord = false;
  }
}

/** Hand the bot's authoritative loot roll to Hollow Hoard for a read-only display. */
function showBotLoot(data) {
  const api = game.modules.get("hollow-hoard")?.api;
  if (api?.populateFromBot) {
    try { api.populateFromBot(data.items || [], { encounterIds: data.encounter_ids || [] }); }
    catch (err) { console.warn(`${MOD} | Hollow Hoard populate failed`, err); }
  } else {
    console.warn(`${MOD} | Hollow Hoard not installed/active — loot mirror skipped`);
  }
}

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
// New logins are created with the shared starter password + a mustChangePassword
// flag; the member is forced to set their own password on first login.
async function handleProvisionOp(op, args) {
  switch (op) {
    case "ensure_user": {
      const name = String(args.login || "Adventurer");
      let user = (game.users.getName?.(name)) || game.users.find((u) => u.name === name);
      if (!user) {
        user = await User.create({
          name, role: args.role ?? 1, password: STARTER_PASSWORD,
          flags: { [MOD]: { mustChangePassword: true } },
        });
      }
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
      // Restore the shared starter + forced-change so the member re-sets it on next login.
      if (u) await u.update({ password: STARTER_PASSWORD, [`flags.${MOD}.mustChangePassword`]: true });
      return {};
    }
    case "rename_user": {
      const u = game.users.get(args.userId);
      if (u) await u.update({ name: String(args.login || u.name) });
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

// ── Forced first-login password change ─────────────────────────────────────────
// A login created with the shared starter password carries flags.mythros.
// mustChangePassword. On ready we block that member with a dialog until they set
// their own password. Best-effort: if Foundry refuses the self-update, we clear the
// flag and tell them to ask a GM, rather than trapping them.
async function enforcePasswordChange() {
  const u = game.user;
  if (!u || !u.getFlag(MOD, "mustChangePassword")) return;
  const Dialog = foundry.applications.api.DialogV2;
  for (;;) {
    const res = await Dialog.prompt({
      window: { title: "Set your Foundry password", icon: "fa-solid fa-key" },
      content: `
        <p>Welcome to Ashreach! You're signed in with the shared starter password.
        Please set your own password to continue.</p>
        <div class="form-group"><label>New password</label>
          <input type="password" name="pw1" autocomplete="new-password"/></div>
        <div class="form-group"><label>Confirm password</label>
          <input type="password" name="pw2" autocomplete="new-password"/></div>`,
      ok: { label: "Set password", callback: (_e, btn) => ({
        pw1: btn.form.pw1.value, pw2: btn.form.pw2.value,
      }) },
      rejectClose: false,
    }).catch(() => null);

    if (!res) { ui.notifications?.warn("You must set a password to continue."); continue; }
    if (!res.pw1 || res.pw1.length < 4) { ui.notifications?.warn("Use at least 4 characters."); continue; }
    if (res.pw1 !== res.pw2) { ui.notifications?.warn("Passwords don't match."); continue; }
    if (res.pw1 === STARTER_PASSWORD) { ui.notifications?.warn("Choose a different password from the starter."); continue; }
    try {
      await u.update({ password: res.pw1 });
      await u.unsetFlag(MOD, "mustChangePassword");
      ui.notifications?.info("Password updated. You're all set.");
      return;
    } catch (err) {
      console.warn(`${MOD} | self password change failed`, err);
      try { await u.unsetFlag(MOD, "mustChangePassword"); } catch (e) { /* best-effort */ }
      ui.notifications?.error("Couldn't set your password automatically — ask a GM to set it for you.");
      return;
    }
  }
}

// ── Core-field lock: players keep their actor but can't edit MythrOS-owned fields ─
function touchesLockedActorField(changes) {
  const flat = foundry.utils.flattenObject(changes || {});
  for (const key of Object.keys(flat)) {
    if (key === "name") return true;
    if (key.startsWith("system.abilities.")) return true;            // ability scores
    if (key.startsWith("system.attributes.hp.max")) return true;     // max HP (current HP stays editable)
    if (key.startsWith("system.attributes.ac.")) return true;        // AC
    if (key.startsWith("system.attributes.prof")) return true;       // proficiency bonus
    if (key.startsWith("system.details.level")) return true;         // level
    if (key.startsWith("system.details.xp")) return true;
    if (key.startsWith("system.details.cr")) return true;
    if (key.startsWith("system.skills.")) return true;               // skill proficiencies
    if (key.startsWith("system.traits.")) return true;               // languages + weapon/armor/tool/save proficiencies
  }
  return false;
}

function sheetsLocked() {
  return S("lockPlayerSheets") && !game.user?.isGM;  // GMs (and the bridge worker GM) always edit freely
}

Hooks.on("preUpdateActor", (actor, changes) => {
  if (!sheetsLocked() || actor.type !== "character") return true;
  if (!touchesLockedActorField(changes)) return true;
  ui.notifications?.warn("That part of your sheet is kept in sync from MythrOS and can't be edited here.");
  return false;  // veto
});

function lockedActorItem(item) {
  const parent = item?.parent;
  return parent?.documentName === "Actor" && parent.type === "character"
    && PLAYER_LOCKED_ITEM_TYPES.has(item.type);
}

Hooks.on("preCreateItem", (item) => {
  if (!sheetsLocked() || !lockedActorItem(item)) return true;
  ui.notifications?.warn("Class, race, and background are managed by MythrOS.");
  return false;
});
Hooks.on("preDeleteItem", (item) => {
  if (!sheetsLocked() || !lockedActorItem(item)) return true;
  ui.notifications?.warn("Class, race, and background are managed by MythrOS.");
  return false;
});
Hooks.on("preUpdateItem", (item, changes) => {
  if (!sheetsLocked() || !lockedActorItem(item)) return true;
  // Allow incidental edits (e.g. description) but not name or level changes.
  if (changes.name !== undefined || foundry.utils.hasProperty(changes, "system.levels")) {
    ui.notifications?.warn("Class level is managed by MythrOS.");
    return false;
  }
  return true;
});

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
  // The secret rides the WebSocket subprotocol (a browser WS can't set headers, but it
  // can offer subprotocols) so it never appears in the URL/query — and never in logs.
  // Only the gm id (not a secret) stays in the query string.
  const url = `${wsBase}/api/v1/foundry/socket?gm=${encodeURIComponent(gmId)}`;

  try {
    _ws = new WebSocket(url, ["mythros-bridge.v1", secret]);
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
      // Phase B2: a combat snapshot drives Foundry tokens/turn, not the chat log.
      if (data.kind === "combat") { await applyDiscordCombat(data); return; }
      // Loot mirror: the bot rolled the authoritative hoard for the GM's last
      // encounter → show it read-only in Hollow Hoard (claiming stays on Discord).
      if (data.kind === "loot") { showBotLoot(data); return; }
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

/** Pull the GM's most-recent encounter loot from MythrOS and show it in Hollow Hoard. */
async function fetchLastLoot() {
  const secret = S("sharedSecret");
  const gmId = S("gmDiscordId");
  const base = (S("webBaseUrl") || "").replace(/\/+$/, "");
  if (!secret || !gmId || !base) { ui.notifications?.warn("Bridge not configured."); return; }
  const api = game.modules.get("hollow-hoard")?.api;
  if (!api?.populateFromBot) { ui.notifications?.warn("Hollow Hoard isn't active."); return; }
  try {
    const res = await fetch(`${base}/api/v1/foundry/loot/last?gm=${encodeURIComponent(gmId)}`, {
      headers: { "Authorization": `Bearer ${secret}` },
    });
    if (!res.ok) { ui.notifications?.warn("Couldn't fetch the last hoard."); return; }
    const data = await res.json();
    if (!(data.items || []).length) { ui.notifications?.info("No recent loot to show."); return; }
    api.populateFromBot(data.items, { encounterIds: data.encounter_id ? [data.encounter_id] : [] });
  } catch (err) {
    console.warn(`${MOD} | fetch last loot failed`, err);
  }
}

// "Last Hoard (MythrOS)" scene-control button — reopens the bot's most-recent roll.
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM || !game.modules.get("hollow-hoard")?.active) return;
  const group = controls?.tokens ?? controls?.token
    ?? (Array.isArray(controls) ? controls.find((c) => c.name === "tokens" || c.name === "token") : null);
  if (!group?.tools) return;
  const tool = {
    name: "mythros-last-hoard", title: "Last Hoard (MythrOS)", icon: "fa-solid fa-coins",
    order: 100, button: true, visible: true, onChange: () => fetchLastLoot(), onClick: () => fetchLastLoot(),
  };
  if (Array.isArray(group.tools)) group.tools.push(tool);
  else group.tools["mythros-last-hoard"] = tool;
});

Hooks.once("ready", () => {
  if (game.user?.isGM) connectSocket();
  injectBrand();   // cosmetic, every client
  enforcePasswordChange();   // every client: force off the shared starter password
});
