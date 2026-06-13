# MythrOS Foundry Bridge

Two-way **chat + dice-roll relay** between a self-hosted **Foundry VTT (dnd5e)**
world and the **MythrOS** Discord server for KoTT.gg / Ashreach.

- **Foundry → Discord** — public chat and rolls in the live session mirror into the
  session's in-game Discord channel.
- **Discord → Foundry** — messages typed in that Discord channel appear in the
  Foundry chat log, so players who stay out of Foundry still take part.

> **Separate repository.** This is the Foundry-side companion to MythrOS; it lives
> in its own repo so Foundry can install/update it via a manifest URL. The bot/web
> half ships in the MythrOS repo (`web/app.py` relay endpoints + the bot's
> `FoundryBridgeListener` / `foundry_relay_cog`).

---

## How it works

```
Foundry world (GM browser)         MythrOS web (public, TLS)        MythrOS bot
──────────────────────────         ─────────────────────────        ───────────
createChatMessage hook  ──POST───▶ /api/v1/foundry/relay  ──NOTIFY foundry──▶ FoundryBridgeListener
  (public msgs only)               (Bearer secret)         origin='foundry'    → posts to the session's
                                                                                  in-game channel

ChatMessage.create  ◀──WebSocket── /api/v1/foundry/socket ◀─NOTIFY foundry── foundry_relay_cog
  flags.mythros.relayed=true       (secret + gm query)     origin='discord'    on_message in that channel
```

The bot and web share one Postgres DB and pass relay events over the `foundry`
`LISTEN/NOTIFY` channel with an `origin` field — the same echo-loop-safe mechanism
the live combat tracker uses. **Loop guards:** injected messages carry
`flags.mythros.relayed` (the outbound hook skips them) and only the **primary active
GM** relays/injects (so multiple open clients don't multiply a message).
**Privacy:** GM whispers, blind rolls, and self rolls are never sent to Discord.

---

## Combat augmentation (MythrOS combat feel)

Layered on top of the dnd5e combat engine — it does **not** replace it. Toggle with the
**MythrOS combat augmentation** master setting.

| Feature | What it does |
|---------|--------------|
| **Hidden monster HP** | When combat begins, non-PC token bars are set GM-only so players can't read monster HP. (Setting: *Hide monster HP from players*.) |
| **Turn-prep declarations** | When the active turn lands on a PC you own, you're prompted to declare movement / action / bonus / target / notes. The declaration posts to chat and is stored on the combatant. |
| **Permadeath** | A PC that reaches **3 death-save failures** is locked dead — a death status overlay is applied and a death card posts. Death is permanent. |

> Phase A is **Foundry-local**. Phase B wires turn-prep, HP, and permadeath two-way to a live
> Discord combat tracker so the table can act from either side.

---

## Install

1. In Foundry: **Add-on Modules → Install Module**, paste the manifest URL:
   `https://github.com/Hawkyns-DND/mythros-foundry-bridge/releases/latest/download/module.json`
2. Enable **MythrOS Foundry Bridge** in your world's module list.
3. Configure it: **Game Settings → Configure Settings → MythrOS Foundry Bridge**:

   | Setting | Value |
   |---------|-------|
   | MythrOS web base URL | `https://kottrpg.com` |
   | Bridge shared secret | the value of `FOUNDRY_BRIDGE_SECRET` set on the bot/web |
   | GM Discord user ID | the Discord user id of the GM running sessions |
   | Enable relay / rolls / chat | on |
   | MythrOS combat augmentation | on (hidden HP / turn-prep / permadeath) |
   | Hide monster HP from players | on |

The relay only fires while that GM has a **live MythrOS session** (provisioned /
active / campfire). Foundry→Discord lands in that session's in-game channel; if the
GM has no live session, those messages are simply not mirrored.

### Operator (server side, once)

```bash
# On the Vultr box, set the shared secret for the bot + web (same value), then
# rebuild. Generate one with:  python -c "import secrets; print(secrets.token_urlsafe(32))"
echo 'FOUNDRY_BRIDGE_SECRET=<paste>' >> ~/MythrOS/.env
docker compose up -d --build bot web
```

Nginx must forward the WebSocket upgrade for `/api/v1/foundry/socket` (the combat
tracker already needs WS upgrade headers, so this usually works with no change).

---

## Recommended companion Foundry modules

The bridge handles Discord ⇆ Foundry. For the rest of the table, these pair well:

**Combat automation**
- **socketlib**, **lib-wrapper** — dependencies for the below.
- **Midi-QOL** — automates attack → hit/miss → damage → saves → effects.
- **DFreds Convenient Effects** + **DAE** + **Times Up** — the effect/condition layer.
- **JB2A** + **Automated Animations** — auto-played spell/attack VFX.

**Seeing where players are (West Marches)**
- **Party Overview** — one panel: every PC's HP/AC/conditions and current scene.
- **Monk's Active Tile Triggers** — auto scene transitions when a party crosses a map edge.
- **Simple Calendar** — in-world date/time per party.

> Do **not** also install `foundrytodiscord`. It mirrors Foundry→Discord on its own
> and would double-post (and risk an echo loop) alongside this bridge — this module
> owns both directions.

---

## License

MIT (or match the MythrOS project license at release).
