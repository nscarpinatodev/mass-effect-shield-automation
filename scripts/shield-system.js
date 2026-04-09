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

const MODULE_ID = 'mass-effect-shield-automation';

// ── SETTINGS ─────────────────────────────────────────────────────────────────

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'takeCoverSlug', {
    name: 'Take Cover Effect Slug',
    hint: 'The slug of the "Take Cover" effect in your system. Used to detect when a depleted actor has taken cover and can begin recharging.',
    scope: 'world',
    config: true,
    type: String,
    default: 'effect-cover',
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

// Registered on a named variable so we can confirm it in the console:
//   Hooks._hooks['pf2e.startTurn']
Hooks.on('pf2e.startTurn', async (first, second) => {
  // PF2e changed the argument order in a recent release.
  // Defensively detect which argument is the combatant by checking for .actor.
  const combatant = first?.actor  ? first
                  : second?.actor ? second
                  : null;

  console.log(`ME Shields | pf2e.startTurn fired`);
  console.log(`  arg[0]: ${first?.constructor?.name}  name="${first?.name}"  hasActor=${!!first?.actor}`);
  console.log(`  arg[1]: ${second?.constructor?.name}  name="${second?.name}"  hasActor=${!!second?.actor}`);
  console.log(`  resolved combatant: ${combatant?.name ?? 'none'}`);

  if (!game.user.isGM) {
    console.log('ME Shields | Skipping — current user is not GM');
    return;
  }

  const actor = combatant?.actor;
  if (!actor) {
    console.log('ME Shields | Skipping — no actor on combatant (neither argument had .actor)');
    return;
  }
  console.log(`ME Shields | Actor: ${actor.name} (id: ${actor.id})`);

  const shield = getShieldEffect(actor);
  if (!shield) {
    console.log(`ME Shields | No shield effect found on ${actor.name} — checking all effects:`);
    for (const e of (actor.itemTypes?.effect ?? [])) {
      console.log(`  effect "${e.name}" | slug: ${e.system?.slug} | flags:`, e.flags?.[MODULE_ID]);
    }
    return;
  }
  console.log(`ME Shields | Shield effect found: "${shield.name}"`);

  const max     = shield.getFlag(MODULE_ID, 'shieldMax')   ?? 0;
  const regen   = shield.getFlag(MODULE_ID, 'shieldRegen') ?? 0;
  const current = actor.system.attributes.hp.temp ?? 0;
  console.log(`ME Shields | max=${max} regen=${regen} current tempHP=${current}`);

  if (max === 0 || regen === 0) {
    console.warn(`ME Shields | Shield flags missing or zero — max=${max}, regen=${regen}. Were the effects created with createShieldEffects()?`);
    return;
  }

  if (current > 0) {
    if (current >= max) {
      console.log('ME Shields | Shields already full — skipping regen');
      return;
    }
    const newTemp  = Math.min(current + regen, max);
    const restored = newTemp - current;
    console.log(`ME Shields | Recharging: ${current} → ${newTemp} (+${restored})`);
    await actor.update({ 'system.attributes.hp.temp': newTemp });
    postChat(actor, rechargeHtml(newTemp, max, restored));

  } else {
    const inCover = hasTakeCover(actor);
    console.log(`ME Shields | Shields depleted — inCover=${inCover} (checking slug "${game.settings.get(MODULE_ID, 'takeCoverSlug')}")`);
    if (inCover) {
      const newTemp = Math.min(regen, max);
      console.log(`ME Shields | Cover taken — restoring to ${newTemp}`);
      await actor.update({ 'system.attributes.hp.temp': newTemp });
      postChat(actor, restoringHtml(newTemp, max));
    } else {
      console.log('ME Shields | No cover — shields remain offline');
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

function getWhisperRecipients(actor) {
  const ids = new Set(game.users.filter(u => u.isGM).map(u => u.id));
  for (const [userId, level] of Object.entries(actor.ownership ?? {})) {
    if (userId === 'default') continue;
    if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) ids.add(userId);
  }
  return [...ids];
}

function postChat(actor, content) {
  ChatMessage.create({
    speaker: { alias: `⚡ ${actor.name}` },
    content,
    whisper: getWhisperRecipients(actor),
  });
}

// ── CHAT HTML ─────────────────────────────────────────────────────────────────

const C = {
  active:  '#4fc3f7', // cyan  — shields up
  broken:  '#ef5350', // red   — shields offline
  restore: '#66bb6a', // green — shields coming back
};

function shieldBar(current, max, color) {
  const pct = max > 0 ? Math.round((current / max) * 100) : 0;
  return `<div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
    <div style="flex:1;background:rgba(0,0,0,0.3);border-radius:3px;height:7px;overflow:hidden;">
      <div style="width:${pct}%;background:${color};height:100%;border-radius:3px;"></div>
    </div>
    <span style="font-size:0.85em;white-space:nowrap;"><strong>${current}/${max}</strong></span>
  </div>`;
}

function card(color, body) {
  return `<div style="border-left:3px solid ${color};padding:5px 10px;`
    + `background:${color}18;border-radius:2px;font-size:0.95em;">${body}</div>`;
}

function rechargeHtml(current, max, restored) {
  return card(C.active,
    `<strong>⚡ Shields Recharging</strong> +${restored}`
    + shieldBar(current, max, C.active)
  );
}

function restoringHtml(current, max) {
  return card(C.restore,
    `<strong>🛡️ Shields Coming Online</strong><br>`
    + `Cover taken — kinetic barrier beginning to recharge.`
    + shieldBar(current, max, C.restore)
  );
}

function offlineHtml(max) {
  return card(C.broken,
    `<strong>🛡️ Shields Offline</strong><br>`
    + `Kinetic barrier is depleted. <em>Take Cover to begin recharging.</em>`
    + shieldBar(0, max, C.broken)
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

// ── DEBUG UTILITY ─────────────────────────────────────────────────────────────
//
// Run from the Foundry browser console at any time:
//   MassEffectShields.debug()        — inspect the selected/first token
//   MassEffectShields.debug(actor)   — inspect a specific actor object
//
function debugShields(actor) {
  actor ??= canvas.tokens.controlled[0]?.actor ?? game.combat?.combatant?.actor;
  if (!actor) {
    console.warn('ME Shields | debug(): no actor selected and no active combatant');
    return;
  }

  console.group(`ME Shields | Debug — ${actor.name}`);
  console.log('Actor id:', actor.id);
  console.log('isGM:', game.user.isGM);
  console.log('tempHP (current):', actor.system.attributes.hp.temp);

  const shield = getShieldEffect(actor);
  if (shield) {
    const max   = shield.getFlag(MODULE_ID, 'shieldMax')   ?? '(not set)';
    const regen = shield.getFlag(MODULE_ID, 'shieldRegen') ?? '(not set)';
    console.log('Shield effect:', shield.name, `| slug: ${shield.system?.slug}`);
    console.log(`  shieldMax=${max}  shieldRegen=${regen}`);
    console.log('  Full flags:', shield.flags?.[MODULE_ID]);
  } else {
    console.warn('No shield effect found on actor.');
    console.log('All effects on actor:');
    for (const e of (actor.itemTypes?.effect ?? [])) {
      console.log(`  "${e.name}" | slug: ${e.system?.slug} | module flags:`, e.flags?.[MODULE_ID]);
    }
  }

  const coverSlug = game.settings.get(MODULE_ID, 'takeCoverSlug');
  const inCover   = hasTakeCover(actor);
  console.log(`Take Cover slug setting: "${coverSlug}" — actor has cover: ${inCover}`);

  console.log('pf2e.startTurn hooks registered:',
    Hooks._hooks?.['pf2e.startTurn']?.length ?? 0);
  console.groupEnd();
}

globalThis.MassEffectShields = { createShieldEffects, debug: debugShields };
