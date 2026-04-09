'use strict';

// ============================================================
// MASS EFFECT SHIELD SYSTEM — Foundry VTT v13 Module
// System: Pathfinder 2e (Starfinder 2e proxy)
// ============================================================
//
// HOW IT WORKS:
//   Each shielded actor carries a "Kinetic Shield" effect item.
//   The effect stores two module flags:
//     • mass-effect-shields.shieldMax   — maximum shield HP
//     • mass-effect-shields.shieldRegen — HP restored per turn
//
//   The module uses the actor's Temp HP field as the current
//   shield value. No rule elements are used — this module
//   manages the value directly.
//
// TURN-START LOGIC:
//   tempHP > 0  → regen by shieldRegen (cap at shieldMax)
//   tempHP = 0  → check for Take Cover effect:
//                   has cover  → begin recharging (set tempHP to shieldRegen)
//                   no cover   → post "shields offline" message
//
// SETUP:
//   1. Install this module in Foundry VTT.
//   2. Enable it in your world.
//   3. Open the browser console (F12) and run:
//        MassEffectShields.createShieldEffects()
//      This creates 5 tiered shield effects in your Items directory.
//   4. Drag the appropriate tier effect onto any actor's sheet.
//      Their Temp HP will be initialised to the shield's max automatically.
//
// TAKE COVER:
//   The default "Take Cover" effect slug is "effect-take-cover".
//   You can override this in Module Settings if your system uses a
//   different slug.
//
// TO UNINSTALL:
//   Disable or remove the module. No persistent hooks remain.
// ============================================================

const MODULE_ID = 'mass-effect-shields';

// ── SETTINGS ─────────────────────────────────────────────────────────────────

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'takeCoverSlug', {
    name: 'Take Cover Effect Slug',
    hint: 'The slug of the "Take Cover" effect in your system. Used to detect when a depleted actor has taken cover and can begin recharging.',
    scope: 'world',
    config: true,
    type: String,
    default: 'effect-take-cover',
  });

  game.settings.register(MODULE_ID, 'gmOnlyMessages', {
    name: 'GM-Only Shield Messages',
    hint: 'When enabled, shield status messages are whispered to the GM only.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });
});

// ── READY ─────────────────────────────────────────────────────────────────────

Hooks.once('ready', () => {
  const version = game.modules.get(MODULE_ID)?.version ?? '?';
  console.log(`ME Shields | Mass Effect Shield System v${version} loaded.`);
});

// ── EFFECT LIFECYCLE ──────────────────────────────────────────────────────────

// When a shield effect is applied to an actor, initialise their Temp HP.
Hooks.on('createItem', async (item, _options, _userId) => {
  if (!game.user.isGM) return;
  if (!isShieldEffect(item)) return;
  const actor = item.parent;
  if (!actor) return;
  const max = item.getFlag(MODULE_ID, 'shieldMax') ?? 0;
  if (max > 0) await actor.update({ 'system.attributes.hp.temp': max });
});

// When a shield effect is removed, clear Temp HP.
Hooks.on('deleteItem', async (item, _options, _userId) => {
  if (!game.user.isGM) return;
  if (!isShieldEffect(item)) return;
  const actor = item.parent;
  if (!actor) return;
  await actor.update({ 'system.attributes.hp.temp': 0 });
});

// ── TURN-START REGEN ──────────────────────────────────────────────────────────

Hooks.on('pf2e.startTurn', async (encounter, combatant) => {
  if (!game.user.isGM) return;
  const actor = combatant?.actor;
  if (!actor) return;

  const shield = getShieldEffect(actor);
  if (!shield) return;

  const max     = shield.getFlag(MODULE_ID, 'shieldMax')   ?? 0;
  const regen   = shield.getFlag(MODULE_ID, 'shieldRegen') ?? 0;
  const current = actor.system.attributes.hp.temp ?? 0;

  if (current > 0) {
    // Shields are up — apply regen
    if (current >= max) return; // already full, no message needed
    const newTemp  = Math.min(current + regen, max);
    const restored = newTemp - current;
    await actor.update({ 'system.attributes.hp.temp': newTemp });
    postChat(actor, rechargeHtml(newTemp, max, restored));

  } else {
    // Shields depleted — only recharge if the actor has taken cover
    if (hasTakeCover(actor)) {
      const newTemp = Math.min(regen, max);
      await actor.update({ 'system.attributes.hp.temp': newTemp });
      postChat(actor, restoringHtml(newTemp, max));
    } else {
      postChat(actor, offlineHtml(max));
    }
  }
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

function isShieldEffect(item) {
  return item.type === 'effect'
    && item.flags?.[MODULE_ID]?.shieldMax != null;
}

function getShieldEffect(actor) {
  return actor?.itemTypes?.effect?.find(isShieldEffect) ?? null;
}

function hasTakeCover(actor) {
  const slug = game.settings.get(MODULE_ID, 'takeCoverSlug');
  return actor?.itemTypes?.effect?.some(e => e.system?.slug === slug) ?? false;
}

function postChat(actor, content) {
  const gmOnly = game.settings.get(MODULE_ID, 'gmOnlyMessages');
  ChatMessage.create({
    speaker: { alias: `⚡ ${actor.name}` },
    content,
    whisper: gmOnly ? ChatMessage.getWhispers('GM') : [],
  });
}

// ── CHAT HTML ─────────────────────────────────────────────────────────────────

const C = {
  active:  '#4fc3f7', // cyan  — shields up
  broken:  '#ef5350', // red   — shields offline
  restore: '#66bb6a', // green — shields coming back
};

function shieldBar(current, max, width = 12) {
  if (max === 0) return `${current}`;
  const filled = Math.round((current / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled)
    + ` <strong>${current}/${max}</strong>`;
}

function card(color, body) {
  return `<div style="border-left:3px solid ${color};padding:5px 10px;`
    + `background:${color}18;border-radius:2px;font-size:0.95em;">${body}</div>`;
}

function rechargeHtml(current, max, restored) {
  return card(C.active,
    `<strong>⚡ Shields Recharging</strong> +${restored}<br>`
    + `<span style="color:${C.active};font-family:monospace;">${shieldBar(current, max)}</span>`
  );
}

function restoringHtml(current, max) {
  return card(C.restore,
    `<strong>🛡️ Shields Coming Online</strong><br>`
    + `Cover taken — kinetic barrier beginning to recharge.<br>`
    + `<span style="color:${C.restore};font-family:monospace;">${shieldBar(current, max)}</span>`
  );
}

function offlineHtml(max) {
  return card(C.broken,
    `<strong>🛡️ Shields Offline</strong><br>`
    + `Kinetic barrier is depleted. <em>Take Cover to begin recharging.</em><br>`
    + `<span style="color:${C.broken};font-family:monospace;">${shieldBar(0, max)}</span>`
  );
}

// ── EFFECT CREATION UTILITY ───────────────────────────────────────────────────
//
// Run from the Foundry browser console to create all tiered shield effects:
//
//   MassEffectShields.createShieldEffects()
//
// Effects are created in a new "Mass Effect Shields" folder in your world Items.
// Drag the appropriate tier onto any actor to give them a kinetic barrier.

const SHIELD_TIERS = [
  { tier: 1, name: 'Kinetic Shield — Tier 1', max: 20,  regen: 5  },
  { tier: 2, name: 'Kinetic Shield — Tier 2', max: 35,  regen: 8  },
  { tier: 3, name: 'Kinetic Shield — Tier 3', max: 50,  regen: 12 },
  { tier: 4, name: 'Kinetic Shield — Tier 4', max: 70,  regen: 16 },
  { tier: 5, name: 'Kinetic Shield — Tier 5', max: 100, regen: 22 },
];

async function createShieldEffects() {
  if (!game.user.isGM) {
    return ui.notifications.warn('ME Shields | Only the GM can create shield effects.');
  }

  const folder = await Folder.create({
    name: 'Mass Effect Shields',
    type: 'Item',
    color: '#4fc3f7',
  });

  for (const tier of SHIELD_TIERS) {
    await Item.create({
      name: tier.name,
      type: 'effect',
      img: 'icons/magic/defensive/shield-barrier-blue.webp',
      folder: folder.id,
      flags: {
        [MODULE_ID]: {
          shieldMax:   tier.max,
          shieldRegen: tier.regen,
        },
      },
      system: {
        slug: `me-kinetic-shield-t${tier.tier}`,
        description: {
          value:
            `<p>A kinetic barrier providing <strong>${tier.max} Shield HP</strong>.`
            + ` Recharges <strong>${tier.regen} HP per turn</strong>.</p>`
            + `<p>If fully depleted, the wearer must <strong>Take Cover</strong>`
            + ` before the shield will begin recharging.</p>`,
        },
        duration: {
          value:  -1,
          unit:   'unlimited',
          expiry: null,
        },
        rules: [],
      },
    });
  }

  ui.notifications.info(
    `ME Shields | Created ${SHIELD_TIERS.length} shield effects in your Items directory.`
  );
}

globalThis.MassEffectShields = { createShieldEffects };
