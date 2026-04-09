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

});

// ── READY ─────────────────────────────────────────────────────────────────────

Hooks.once('ready', () => {
  const version = game.modules.get(MODULE_ID)?.version ?? '?';
  console.log(`ME Shields | Mass Effect Shield System v${version} loaded.`);
});

// ── EFFECT LIFECYCLE ──────────────────────────────────────────────────────────

// When a shield or barrier effect is applied to an actor, initialise its HP.
Hooks.on('createItem', async (item, _options, _userId) => {
  if (!game.user.isGM) return;
  const actor = item.parent;
  if (!actor) return;

  if (isShieldEffect(item)) {
    const max = item.getFlag(MODULE_ID, 'shieldMax') ?? 0;
    if (max > 0) await actor.update({ 'system.attributes.hp.temp': max });
    return;
  }

  if (isBioticBarrier(item)) {
    // If a barrier already exists, remove it — reactivation always resets to full.
    for (const e of actor.itemTypes.effect.filter(e => isBioticBarrier(e) && e.id !== item.id)) {
      await e.delete();
    }
    const max = item.getFlag(MODULE_ID, 'barrierMax') ?? 0;
    if (max > 0) await item.setFlag(MODULE_ID, 'barrierCurrent', max);
  }
});

// When a shield effect is removed, clear Temp HP.
Hooks.on('deleteItem', async (item, _options, _userId) => {
  if (!game.user.isGM) return;
  if (!isShieldEffect(item)) return;
  const actor = item.parent;
  if (!actor) return;
  await actor.update({ 'system.attributes.hp.temp': 0 });
});

// ── DAMAGE ROUTING ────────────────────────────────────────────────────────────
// Single hook that handles all ME-specific damage rules in priority order:
//   1. Biotic barriers absorb first
//   2. Lightning deals double damage to shields
//   3. Single-hit damage exceeding half shield max collapses shields to 0

Hooks.on('preUpdateActor', (actor, changes, options, _userId) => {
  if (!game.user.isGM) return;

  const barrier = getBioticBarrier(actor);
  const shield  = getShieldEffect(actor);
  if (!barrier && !shield) return;

  // ── Step 1: calculate total incoming damage ──────────────────────────────
  const currentHP   = actor.system.attributes.hp.value;
  const currentTemp = actor.system.attributes.hp.temp ?? 0;
  const newHP   = foundry.utils.getProperty(changes, 'system.attributes.hp.value') ?? currentHP;
  const newTemp = foundry.utils.getProperty(changes, 'system.attributes.hp.temp') ?? currentTemp;

  const totalDamage = Math.max(0, (currentHP - newHP) + (currentTemp - newTemp));
  if (totalDamage <= 0) return;

  // ── Step 2: detect lightning damage type ────────────────────────────────
  // PF2e passes damage context in options — log it once so we can confirm
  // the correct key if lightning detection needs adjustment.
  console.log('ME Shields | preUpdateActor options:', JSON.stringify(options ?? {}));
  const damageTypes = options?.pf2e?.context?.damageTypes
    ?? options?.pf2e?.damageTypes
    ?? options?.pf2e?.context?.traits
    ?? [];
  const isLightning = Array.isArray(damageTypes) && damageTypes.includes('electricity');
  if (isLightning) console.log('ME Shields | Lightning damage detected — shields take double damage');

  // ── Step 3: barrier absorption ───────────────────────────────────────────
  let overflow = totalDamage;
  if (barrier) {
    const barrierCurrent = barrier.getFlag(MODULE_ID, 'barrierCurrent') ?? 0;
    if (barrierCurrent > 0) {
      const barrierAbsorbs = Math.min(barrierCurrent, overflow);
      overflow -= barrierAbsorbs;
      const newBarrier = barrierCurrent - barrierAbsorbs;
      barrier.setFlag(MODULE_ID, 'barrierCurrent', newBarrier); // fire-and-forget
      if (newBarrier === 0) {
        barrier.delete();
        postChat(actor, barrierDepletedHtml());
      }
    }
  }

  // ── Step 4: shield-specific rules ───────────────────────────────────────
  const shieldMax = shield?.getFlag(MODULE_ID, 'shieldMax') ?? 0;

  // Damage reaching the shield layer (before special rules).
  const rawShieldDamage = Math.min(overflow, currentTemp);

  // Lightning: shields absorb double the normal amount, HP overflow unchanged.
  const effectiveShieldDamage = isLightning
    ? Math.min(rawShieldDamage * 2, currentTemp)
    : rawShieldDamage;

  // Massive damage collapse: a single hit dealing more than half shield max
  // instantly drops shields to 0, even if they would have survived.
  const massiveThreshold = shieldMax / 2;
  const isCollapse = shield && currentTemp > 0
    && effectiveShieldDamage > massiveThreshold;

  const finalShieldHP = isCollapse ? 0 : Math.max(0, currentTemp - effectiveShieldDamage);

  // HP overflow uses original (non-doubled) overflow so lightning doesn't
  // also double damage to actual HP.
  const hpDamage = Math.max(0, overflow - currentTemp);

  // ── Step 5: rewrite the changes ─────────────────────────────────────────
  foundry.utils.setProperty(changes, 'system.attributes.hp.temp',  finalShieldHP);
  foundry.utils.setProperty(changes, 'system.attributes.hp.value', currentHP - hpDamage);

  // ── Step 6: post messages ────────────────────────────────────────────────
  if (isLightning && shield && rawShieldDamage > 0) {
    postChat(actor, lightningShieldHtml(effectiveShieldDamage, currentTemp, finalShieldHP, shieldMax));
  }
  if (isCollapse) {
    postChat(actor, shieldCollapseHtml(shieldMax));
  }
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

  const shield  = getShieldEffect(actor);
  const barrier = getBioticBarrier(actor);

  if (!shield && !barrier) {
    console.log(`ME Shields | No shield or barrier on ${actor.name} — skipping`);
    return;
  }

  // ── Shield handling ────────────────────────────────────────────────────────
  if (shield) {
    console.log(`ME Shields | Shield effect found: "${shield.name}"`);

    const max     = shield.getFlag(MODULE_ID, 'shieldMax')   ?? 0;
    const regen   = shield.getFlag(MODULE_ID, 'shieldRegen') ?? 0;
    const current = actor.system.attributes.hp.temp ?? 0;
    console.log(`ME Shields | max=${max} regen=${regen} current tempHP=${current}`);

    if (max === 0 || regen === 0) {
      console.warn(`ME Shields | Shield flags missing or zero — max=${max}, regen=${regen}. Were the effects created with createShieldEffects()?`);
    } else if (current > 0) {
      if (current >= max) {
        console.log('ME Shields | Shields already full — posting status');
        postChat(actor, fullHtml(max));
      } else {
        const newTemp  = Math.min(current + regen, max);
        const restored = newTemp - current;
        console.log(`ME Shields | Recharging: ${current} → ${newTemp} (+${restored})`);
        await actor.update({ 'system.attributes.hp.temp': newTemp });
        postChat(actor, rechargeHtml(newTemp, max, restored));
      }
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
  }

  // ── Barrier handling ───────────────────────────────────────────────────────
  if (barrier) {
    const barrierMax     = barrier.getFlag(MODULE_ID, 'barrierMax')     ?? 0;
    const barrierCurrent = barrier.getFlag(MODULE_ID, 'barrierCurrent') ?? 0;
    console.log(`ME Shields | Barrier current=${barrierCurrent}/${barrierMax}`);

    if (barrierCurrent <= 0) {
      // Safety cleanup — should already be gone via preUpdateActor, but just in case.
      console.log('ME Shields | Barrier at 0 HP — removing effect');
      await barrier.delete();
    } else {
      postChat(actor, barrierStatusHtml(barrierCurrent, barrierMax));
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

function isBioticBarrier(item) {
  return item.type === 'effect'
    && item.flags?.[MODULE_ID]?.barrierMax != null;
}

function getBioticBarrier(actor) {
  return actor?.itemTypes?.effect?.find(isBioticBarrier) ?? null;
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
  active:   '#4fc3f7', // cyan        — shields up
  broken:   '#ef5350', // red         — shields offline
  restore:  '#66bb6a', // green       — shields coming back
  barrier:  '#ce93d8', // purple      — biotic barrier
  overload: '#ff6f00', // deep orange — shield collapse
  lightning:'#fff176', // yellow      — lightning strike
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

function fullHtml(max) {
  return card(C.active,
    `<strong>⚡ Shields at Full Capacity</strong>`
    + shieldBar(max, max, C.active)
  );
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

function lightningShieldHtml(shieldDamage, _prevTemp, finalShieldHP, shieldMax) {
  return card(C.lightning,
    `<strong>⚡ Lightning Strike — Shields take double damage!</strong><br>`
    + `Shield damage: <strong>${shieldDamage}</strong> (${shieldDamage / 2} × 2)`
    + shieldBar(finalShieldHP, shieldMax, C.lightning)
  );
}

function shieldCollapseHtml(shieldMax) {
  return card(C.overload,
    `<strong>🔴 Shield Overload — Shields Collapsed!</strong><br>`
    + `Massive hit exceeded overload threshold (${Math.ceil(shieldMax / 2)} damage). `
    + `<em>Take Cover to restart.</em>`
    + shieldBar(0, shieldMax, C.overload)
  );
}

function barrierStatusHtml(current, max) {
  return card(C.barrier,
    `<strong>🔵 Biotic Barrier</strong>`
    + shieldBar(current, max, C.barrier)
  );
}

function barrierDepletedHtml() {
  return card(C.barrier,
    `<strong>🔵 Biotic Barrier Collapsed</strong><br>`
    + `Barrier depleted — spend actions to reactivate.`
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

// ── BARRIER CREATION UTILITY ──────────────────────────────────────────────────
//
// Run from the Foundry browser console:
//   MassEffectShields.createBarrierEffects()
//
// Creates tiered biotic barrier effects based on the formula: 5 × floor(level / 2).
// Drag the appropriate tier onto any actor to give them a biotic barrier.
// Barriers activate at full strength and do not regen per turn.

const BARRIER_TIERS = [
  { tier: 1, name: 'Biotic Barrier — Tier 1', levelEquiv: 2,  max: 5  },
  { tier: 2, name: 'Biotic Barrier — Tier 2', levelEquiv: 4,  max: 10 },
  { tier: 3, name: 'Biotic Barrier — Tier 3', levelEquiv: 6,  max: 15 },
  { tier: 4, name: 'Biotic Barrier — Tier 4', levelEquiv: 8,  max: 20 },
  { tier: 5, name: 'Biotic Barrier — Tier 5', levelEquiv: 10, max: 25 },
  { tier: 6, name: 'Biotic Barrier — Tier 6', levelEquiv: 12, max: 30 },
];

async function createBarrierEffects() {
  if (!game.user.isGM) {
    return ui.notifications.warn('ME Shields | Only the GM can create barrier effects.');
  }

  const folder = await Folder.create({
    name: 'Mass Effect Barriers',
    type: 'Item',
    color: '#ce93d8',
  });

  for (const tier of BARRIER_TIERS) {
    await Item.create({
      name: tier.name,
      type: 'effect',
      img: 'icons/magic/light/orb-lightball-blue-purple-pink.webp',
      folder: folder.id,
      flags: {
        [MODULE_ID]: {
          barrierMax: tier.max,
        },
      },
      system: {
        slug: `me-biotic-barrier-t${tier.tier}`,
        description: {
          value:
            `<p>A biotic barrier providing <strong>${tier.max} Barrier HP</strong>`
            + ` (character level ~${tier.levelEquiv}, formula: 5 × ⌊level ÷ 2⌋).</p>`
            + `<p>Barriers absorb damage before shields and actual HP. They do not`
            + ` recharge per turn — spend actions to reactivate at full strength.</p>`,
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
    `ME Shields | Created ${BARRIER_TIERS.length} barrier effects in your Items directory.`
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

  const barrier = getBioticBarrier(actor);
  if (barrier) {
    const bMax     = barrier.getFlag(MODULE_ID, 'barrierMax')     ?? '(not set)';
    const bCurrent = barrier.getFlag(MODULE_ID, 'barrierCurrent') ?? '(not set)';
    console.log('Biotic barrier effect:', barrier.name, `| slug: ${barrier.system?.slug}`);
    console.log(`  barrierMax=${bMax}  barrierCurrent=${bCurrent}`);
    console.log('  Full flags:', barrier.flags?.[MODULE_ID]);
  } else {
    console.log('No biotic barrier effect on actor.');
  }

  const coverSlug = game.settings.get(MODULE_ID, 'takeCoverSlug');
  const inCover   = hasTakeCover(actor);
  console.log(`Take Cover slug setting: "${coverSlug}" — actor has cover: ${inCover}`);
  console.groupEnd();
}

globalThis.MassEffectShields = {
  createShieldEffects,
  createBarrierEffects,
  debug: debugShields,
};
