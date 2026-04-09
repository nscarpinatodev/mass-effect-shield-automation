'use strict';

// ============================================================
// MASS EFFECT SHIELD SYSTEM — Foundry VTT v13 Module
// System: Pathfinder 2e (Starfinder 2e proxy)
// ============================================================
//
// HOW IT WORKS:
//   Shields and mods are equipment items installed on armor. The equipment items
//   carry module flags directly and are detected by the hooks below. For PCs,
//   items must be equipped (worn/installed) to be active. For NPCs, all items in
//   inventory are treated as active since NPCs have no equip/unequip UI.
//
//   Equipment items carry the module flags:
//     • mass-effect-shields.shieldMax   — maximum shield HP
//     • mass-effect-shields.shieldRegen — HP restored per turn
//     • mass-effect-shields.shieldHpBonus — flat HP bonus from HP mods
//     • mass-effect-shields.regenMult   — regen multiplier from regen mods
//
//   The module uses the actor's Temp HP field as the current shield value.
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

  // Hidden — tracks which module version last synced the world-item templates.
  // When the version changes, effects are automatically recreated on next load.
  game.settings.register(MODULE_ID, 'lastSyncedVersion', {
    scope: 'world',
    config: false,
    type: String,
    default: '',
  });
});

// ── READY ─────────────────────────────────────────────────────────────────────

Hooks.once('ready', async () => {
  const version = game.modules.get(MODULE_ID)?.version ?? '?';
  console.log(`ME Shields | Mass Effect Shield System v${version} loaded.`);
  if (game.user.isGM) await syncEffects(version);
});

// ── EFFECT LIFECYCLE ──────────────────────────────────────────────────────────

// When a shield or mod item is applied to an actor, initialise the appropriate values.
Hooks.on('createItem', async (item, _options, _userId) => {
  if (!game.user.isGM) return;
  const actor = item.parent;
  if (!actor) return;

  if (isShieldEffect(item)) {
    const baseMax  = item.getFlag(MODULE_ID, 'shieldMax') ?? 0;
    const hpMod    = getShieldHpMod(actor);
    const hpBonus  = hpMod ? (hpMod.getFlag(MODULE_ID, 'shieldHpBonus') ?? 0) : 0;
    const effectiveMax = baseMax + hpBonus;
    if (effectiveMax > 0) await actor.update({ 'system.attributes.hp.temp': effectiveMax });
    return;
  }

  if (isShieldHpMod(item)) {
    // Remove any pre-existing HP mod (only one can be active at a time).
    for (const e of [...(actor.itemTypes?.equipment ?? []), ...(actor.itemTypes?.effect ?? [])]
        .filter(e => isShieldHpMod(e) && e.id !== item.id)) {
      await e.delete();
    }
    const shield = getShieldEffect(actor);
    if (shield) {
      const baseMax  = shield.getFlag(MODULE_ID, 'shieldMax') ?? 0;
      const hpBonus  = item.getFlag(MODULE_ID, 'shieldHpBonus') ?? 0;
      const effectiveMax = baseMax + hpBonus;
      if (effectiveMax > 0) await actor.update({ 'system.attributes.hp.temp': effectiveMax });
    }
    return;
  }

  if (isRegenMod(item)) {
    // Remove any pre-existing regen mod (only one can be active at a time).
    for (const e of [...(actor.itemTypes?.equipment ?? []), ...(actor.itemTypes?.effect ?? [])]
        .filter(e => isRegenMod(e) && e.id !== item.id)) {
      await e.delete();
    }
    return;
  }

  if (isBioticBarrier(item)) {
    // If a barrier already exists, remove it — reactivation always resets to full.
    for (const e of actor.itemTypes.effect.filter(e => isBioticBarrier(e) && e.id !== item.id)) {
      await e.delete();
    }

    // If barrierMax is already set (old-style tier item), use it;
    // otherwise compute from actor level: 5 × floor(level / 2), minimum 5.
    const existingMax = item.getFlag(MODULE_ID, 'barrierMax');
    const level = actor.level ?? 1;
    const max = existingMax ?? Math.max(5, 5 * Math.floor(level / 2));

    await item.update({
      [`flags.${MODULE_ID}.barrierMax`]:     max,
      [`flags.${MODULE_ID}.barrierCurrent`]: max,
      'system.badge': { type: 'counter', value: max, max },
    });
  }
});

Hooks.on('deleteItem', async (item, _options, _userId) => {
  if (!game.user.isGM) return;
  const actor = item.parent;
  if (!actor) return;

  if (isShieldEffect(item)) {
    // Pass shieldRemoval so preUpdateActor doesn't treat the tempHP drop as incoming damage.
    await actor.update(
      { 'system.attributes.hp.temp': 0 },
      { [MODULE_ID]: { shieldRemoval: true } }
    );
    return;
  }

  if (isShieldHpMod(item)) {
    const shield = getShieldEffect(actor);
    if (shield) {
      const baseMax     = shield.getFlag(MODULE_ID, 'shieldMax') ?? 0;
      const currentTemp = actor.system.attributes.hp.temp ?? 0;
      if (currentTemp > baseMax) {
        await actor.update(
          { 'system.attributes.hp.temp': baseMax },
          { [MODULE_ID]: { shieldRemoval: true } }
        );
      }
    }
  }
});

// ── DAMAGE ROUTING ────────────────────────────────────────────────────────────
// Single hook that handles all ME-specific damage rules in priority order:
//   1. Biotic barriers absorb first
//   2. Lightning deals double damage to shields
//   3. Single-hit damage exceeding half shield max collapses shields to 0

Hooks.on('preUpdateActor', (actor, changes, options, _userId) => {
  if (!game.user.isGM) return;
  // Skip damage routing when we're intentionally clearing tempHP (shield removed/unequipped).
  if (options?.[MODULE_ID]?.shieldRemoval) return;

  const barrier = getBioticBarrier(actor);
  const shield  = getShieldEffect(actor);
  if (!barrier && !shield) return;

  // ── Step 1: calculate total incoming damage ──────────────────────────────
  const currentHP   = actor.system.attributes.hp.value;
  const currentTemp = actor.system.attributes.hp.temp ?? 0;
  const newHP   = foundry.utils.getProperty(changes, 'system.attributes.hp.value') ?? currentHP;
  const newTemp = foundry.utils.getProperty(changes, 'system.attributes.hp.temp') ?? currentTemp;

  const derivedDamage = Math.max(0, (currentHP - newHP) + (currentTemp - newTemp));
  if (derivedDamage <= 0) return;

  // PF2e caps HP at 0, so if the hit would overkill, derivedDamage is lower
  // than the real roll. options.damageTaken reflects the true damage figure.
  const reportedDamage = options?.damageTaken ?? null;
  const totalDamage    = reportedDamage ?? derivedDamage;

  // ── Step 2: detect electricity damage ───────────────────────────────────
  const isElectricity = isShockWeaponAttack();

  // ── Pre-calculation state log ────────────────────────────────────────────
  const barrierHPBefore = barrier ? (barrier.getFlag(MODULE_ID, 'barrierCurrent') ?? 0) : null;
  const barrierMax      = barrier ? (barrier.getFlag(MODULE_ID, 'barrierMax')     ?? 0) : null;
  const shieldBaseMax   = shield?.getFlag(MODULE_ID, 'shieldMax') ?? 0;
  const shieldHpMod     = shield ? getShieldHpMod(actor) : null;
  const shieldHpBonus   = shieldHpMod ? (shieldHpMod.getFlag(MODULE_ID, 'shieldHpBonus') ?? 0) : 0;
  const shieldMax       = shieldBaseMax + shieldHpBonus;

  console.group(`ME Shields | [${actor.name}] Damage Routing`);
  console.log(`  PRE-STATE    barrier: ${barrierHPBefore ?? 'none'}  shields: ${currentTemp}/${shieldMax}${shieldHpBonus ? ` (base ${shieldBaseMax} +${shieldHpBonus})` : ''}  HP: ${currentHP}`);
  console.log(`  DAMAGE       PF2e reported: ${reportedDamage ?? '(not set)'}  derived from deltas: ${derivedDamage}  using: ${totalDamage}${reportedDamage !== null && reportedDamage !== derivedDamage ? '  ⚠ difference due to HP cap (overkill)' : ''}`);
  console.log(`  FLAGS        electricity: ${isElectricity}`);

  // ── Step 3: barrier absorption ───────────────────────────────────────────
  let overflow = totalDamage;
  if (barrier && barrierHPBefore > 0) {
    const barrierAbsorbs = Math.min(barrierHPBefore, overflow);
    overflow -= barrierAbsorbs;
    const newBarrier = barrierHPBefore - barrierAbsorbs;
    console.log(`  BARRIER      absorbs ${barrierAbsorbs}  (${barrierHPBefore} → ${newBarrier})  overflow after: ${overflow}`);
    barrier.setFlag(MODULE_ID, 'barrierCurrent', newBarrier); // fire-and-forget
    if (newBarrier > 0) {
      barrier.update({ 'system.badge': { type: 'counter', value: newBarrier, max: barrierMax } }); // fire-and-forget
    } else {
      barrier.delete();
      postChat(actor, barrierDepletedHtml());
    }
  } else if (barrier) {
    console.log(`  BARRIER      at 0 HP — no absorption`);
  }

  // ── Step 4: shield-specific rules ───────────────────────────────────────
  const rawShieldDamage = Math.min(overflow, currentTemp);

  // Electricity: double the effective damage against shields.
  const effectiveShieldDamage = isElectricity
    ? Math.min(rawShieldDamage * 2, currentTemp)
    : rawShieldDamage;

  // Massive damage collapse: a single hit exceeding half shield max collapses
  // the shields. When collapsed, the shield only absorbs up to the threshold
  // (shieldMax/2) — all damage above the threshold goes directly to actor HP.
  const massiveThreshold = shieldMax / 2;
  const isCollapse = shield && currentTemp > 0
    && effectiveShieldDamage > massiveThreshold;

  const shieldAbsorbs = isCollapse
    ? Math.ceil(massiveThreshold)                          // round up so no half-HP bleed-through
    : rawShieldDamage;                                     // normal absorption up to current HP
  const finalShieldHP = isCollapse
    ? 0
    : Math.max(0, currentTemp - rawShieldDamage);
  const hpDamage = Math.max(0, Math.floor(overflow - shieldAbsorbs)); // everything above threshold hits HP

  if (shield) {
    console.log(`  SHIELDS      current: ${currentTemp}/${shieldMax}  threshold: ${massiveThreshold}  raw hit: ${rawShieldDamage}${isElectricity ? `  ×2 = ${effectiveShieldDamage}` : ''}  collapse: ${isCollapse}  absorbed: ${shieldAbsorbs}  shields after: ${finalShieldHP}`);
  } else {
    console.log(`  SHIELDS      none`);
  }
  console.log(`  HP           overflow to HP: ${hpDamage}  HP after: ${currentHP} → ${currentHP - hpDamage}`);

  // ── Step 5: rewrite the changes ─────────────────────────────────────────
  foundry.utils.setProperty(changes, 'system.attributes.hp.temp',  finalShieldHP);
  foundry.utils.setProperty(changes, 'system.attributes.hp.value', Math.max(0, currentHP - hpDamage));
  console.groupEnd();

  // ── Step 6: post messages ────────────────────────────────────────────────
  if (isElectricity && shield && rawShieldDamage > 0) {
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

  const parts = [];

  // ── Shield handling ────────────────────────────────────────────────────────
  if (shield) {
    console.log(`ME Shields | Shield effect found: "${shield.name}"`);

    const baseMax   = shield.getFlag(MODULE_ID, 'shieldMax')   ?? 0;
    const baseRegen = shield.getFlag(MODULE_ID, 'shieldRegen') ?? 0;
    const hpMod     = getShieldHpMod(actor);
    const hpBonus   = hpMod ? (hpMod.getFlag(MODULE_ID, 'shieldHpBonus') ?? 0) : 0;
    const max       = baseMax + hpBonus;
    const regenMod  = getRegenMod(actor);
    const mult      = regenMod ? (regenMod.getFlag(MODULE_ID, 'regenMult') ?? 1) : 1;
    const regen     = Math.round(baseRegen * mult);
    const current   = actor.system.attributes.hp.temp ?? 0;
    console.log(`ME Shields | baseMax=${baseMax} hpBonus=${hpBonus} max=${max} baseRegen=${baseRegen} mult=${mult} regen=${regen} current tempHP=${current}`);

    if (baseMax === 0 || baseRegen === 0) {
      console.warn(`ME Shields | Shield flags missing or zero — baseMax=${baseMax}, baseRegen=${baseRegen}. Were the effects created with createShieldEffects()?`);
    } else if (current > 0) {
      if (current >= max) {
        console.log('ME Shields | Shields already full — posting status');
        parts.push(fullHtml(max));
      } else {
        const newTemp  = Math.min(current + regen, max);
        const restored = newTemp - current;
        console.log(`ME Shields | Recharging: ${current} → ${newTemp} (+${restored})`);
        await actor.update({ 'system.attributes.hp.temp': newTemp });
        parts.push(rechargeHtml(newTemp, max, restored));
      }
    } else {
      const inCover = hasTakeCover(actor);
      console.log(`ME Shields | Shields depleted — inCover=${inCover} (checking slug "${game.settings.get(MODULE_ID, 'takeCoverSlug')}")`);
      if (inCover) {
        const newTemp = Math.min(regen, max);
        console.log(`ME Shields | Cover taken — restoring to ${newTemp}`);
        await actor.update({ 'system.attributes.hp.temp': newTemp });
        parts.push(restoringHtml(newTemp, max));
      } else {
        console.log('ME Shields | No cover — shields remain offline');
        parts.push(offlineHtml(max));
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
      parts.push(barrierStatusHtml(barrierCurrent, barrierMax));
    }
  }

  // ── Post combined message ─────────────────────────────────────────────────
  if (parts.length > 0) postChat(actor, parts.join(''));
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

function isShieldEffect(item) {
  return item.flags?.[MODULE_ID]?.shieldMax != null
    && (item.type === 'equipment' || item.type === 'effect');
}

function getShieldEffect(actor) {
  return actor?.itemTypes?.equipment?.find(isShieldEffect)
    ?? actor?.itemTypes?.effect?.find(isShieldEffect)
    ?? null;
}

function isBioticBarrier(item) {
  return item.type === 'effect'
    && (item.flags?.[MODULE_ID]?.barrier === true
        || item.flags?.[MODULE_ID]?.barrierMax != null);
}

function getBioticBarrier(actor) {
  return actor?.itemTypes?.effect?.find(isBioticBarrier) ?? null;
}

function isRegenMod(item) {
  return item.flags?.[MODULE_ID]?.regenMult != null
    && (item.type === 'equipment' || item.type === 'effect');
}

function getRegenMod(actor) {
  return actor?.itemTypes?.equipment?.find(isRegenMod)
    ?? actor?.itemTypes?.effect?.find(isRegenMod)
    ?? null;
}

function isShieldHpMod(item) {
  return item.flags?.[MODULE_ID]?.shieldHpBonus != null
    && (item.type === 'equipment' || item.type === 'effect');
}

function getShieldHpMod(actor) {
  return actor?.itemTypes?.equipment?.find(isShieldHpMod)
    ?? actor?.itemTypes?.effect?.find(isShieldHpMod)
    ?? null;
}


// Check whether the most recent PF2e damage roll came from a Shock-group weapon.
// PF2e populates context.options with roll tags including "item:group:shock",
// which is the most direct way to detect shock/electricity damage.
function isShockWeaponAttack() {
  const recent = [...game.messages.contents].slice(-10).reverse();
  for (const msg of recent) {
    const pf2e = msg.flags?.pf2e;
    if (!pf2e) continue;
    if (pf2e.context?.type !== 'damage-roll') continue;

    const options = pf2e.context?.options ?? [];
    const isElec = options.includes('item:damage:type:electricity');
    console.log(`ME Shields | Damage roll detected — electricity damage: ${isElec}`);
    return isElec;
  }

  console.log('ME Shields | No damage-roll message found in recent chat');
  return false;
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
    + `background:${color}18;border-radius:2px;font-size:0.95em;margin-top:4px;">${body}</div>`;
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

// ── ITEM CREATION UTILITIES ───────────────────────────────────────────────────
//
// Run from the Foundry browser console:
//   MassEffectShields.createShieldEffects()       — base shield
//   MassEffectShields.createShieldHpModEffects()  — HP upgrade mods
//   MassEffectShields.createRegenModEffects()     — regen upgrade mods
//   MassEffectShields.createBarrierEffects()      — biotic barrier effect
//
// Or recreate everything at once:
//   MassEffectShields.sync(true)
//
// Drag the appropriate item onto an actor's sheet to equip it.

async function createShieldEffects() {
  if (!game.user.isGM) {
    return ui.notifications.warn('ME Shields | Only the GM can create shield effects.');
  }

  let folder = game.folders.find(f => f.name === 'Mass Effect Shields' && f.type === 'Item');
  if (!folder) {
    folder = await Folder.create({ name: 'Mass Effect Shields', type: 'Item', color: '#4fc3f7' });
  }

  await Item.create({
    name: 'Kinetic Shield',
    type: 'equipment',
    img: 'icons/magic/defensive/shield-barrier-blue.webp',
    folder: folder.id,
    flags: {
      [MODULE_ID]: {
        shieldMax:   30,
        shieldRegen: 10,
      },
    },
    system: {
      slug: 'me-kinetic-shield',
      description: {
        value:
          `<p>A personal kinetic barrier providing <strong>30 Shield HP</strong>.`
          + ` Recharges <strong>10 HP per turn</strong>.</p>`
          + `<p>Equip <strong>Shield HP</strong> and <strong>Regen</strong> mods to`
          + ` upgrade your barrier. If fully depleted, the wearer must`
          + ` <strong>Take Cover</strong> before the shield will begin recharging.</p>`,
      },
      level:   { value: 1 },
      price:   { value: { sp: 150 } },
      bulk:    { value: 1 },
      equipped: { carryType: 'worn', inSlot: true },
      usage:   { value: 'other' },
      traits:  { value: [], rarity: 'common' },
      rules:   [],
    },
  });

  ui.notifications.info('ME Shields | Created Kinetic Shield item in your Items directory.');
}

// ── BARRIER CREATION UTILITY ──────────────────────────────────────────────────
//
// Run from the Foundry browser console:
//   MassEffectShields.createBarrierEffects()
//
// Creates a single "Biotic Barrier" effect item. When dragged onto an actor,
// the barrier HP is calculated automatically from the actor's level (5 × ⌊level ÷ 2⌋).
// Barriers activate at full strength and do not regen per turn.

async function createBarrierEffects() {
  if (!game.user.isGM) {
    return ui.notifications.warn('ME Shields | Only the GM can create barrier effects.');
  }

  let folder = game.folders.find(f => f.name === 'Mass Effect Barriers' && f.type === 'Item');
  if (!folder) {
    folder = await Folder.create({ name: 'Mass Effect Barriers', type: 'Item', color: '#ce93d8' });
  }

  await Item.create({
    name: 'Biotic Barrier',
    type: 'effect',
    img: 'icons/magic/lightning/barrier-shield-crackling-orb-pink.webp',
    folder: folder.id,
    flags: {
      [MODULE_ID]: {
        barrier: true,   // marker flag; barrierMax is set dynamically at application
      },
    },
    system: {
      slug: 'me-biotic-barrier',
      description: {
        value:
          `<p>A biotic barrier. HP = 5 × ⌊level ÷ 2⌋, calculated at activation.</p>`
          + `<p>Absorbs damage before shields and actual HP. Does not recharge per`
          + ` turn — spend actions to reactivate at full strength.</p>`,
      },
      duration: {
        value:  -1,
        unit:   'unlimited',
        expiry: null,
      },
      rules: [],
    },
  });

  ui.notifications.info('ME Shields | Created Biotic Barrier effect in your Items directory.');
}

const SHIELD_HP_MOD_TIERS = [
  { tier: 1, bonus: 10, level: 3,  price: 600,   name: 'Shield HP Mod — Tier 1' },
  { tier: 2, bonus: 20, level: 6,  price: 2500,  name: 'Shield HP Mod — Tier 2' },
  { tier: 3, bonus: 40, level: 9,  price: 7000,  name: 'Shield HP Mod — Tier 3' },
  { tier: 4, bonus: 70, level: 12, price: 16000, name: 'Shield HP Mod — Tier 4' },
];

async function createShieldHpModEffects() {
  if (!game.user.isGM) {
    return ui.notifications.warn('ME Shields | Only the GM can create HP mod effects.');
  }

  let folder = game.folders.find(f => f.name === 'Mass Effect Mods' && f.type === 'Item');
  if (!folder) {
    folder = await Folder.create({ name: 'Mass Effect Mods', type: 'Item', color: '#80cbc4' });
  }

  for (const mod of SHIELD_HP_MOD_TIERS) {
    await Item.create({
      name: mod.name,
      type: 'equipment',
      img: 'icons/magic/defensive/shield-barrier-glowing-blue.webp',
      folder: folder.id,
      flags: {
        [MODULE_ID]: { shieldHpBonus: mod.bonus },
      },
      system: {
        slug: `me-shield-hp-mod-t${mod.tier}`,
        description: {
          value:
            `<p>A Tier ${mod.tier} armor modification that increases kinetic shield`
            + ` capacity by <strong>+${mod.bonus} HP</strong>`
            + ` (base 30 → ${30 + mod.bonus}).</p>`
            + `<p>Only one Shield HP Mod can be installed at a time.</p>`,
        },
        level:   { value: mod.level },
        price:   { value: { sp: mod.price } },
        bulk:    { value: 0 },
        size:    'tiny',
        equipped: { carryType: 'worn', inSlot: true },
        usage:   { value: 'other' },
        traits:  { value: [], rarity: 'common' },
        rules:   [],
      },
    });
  }

  ui.notifications.info(
    `ME Shields | Created ${SHIELD_HP_MOD_TIERS.length} Shield HP Mod items in your Items directory.`
  );
}

// ── REGEN MOD CREATION UTILITY ───────────────────────────────────────────────
//
// Run from the Foundry browser console:
//   MassEffectShields.createRegenModEffects()
//
// Creates 4 armor modification effects that multiply shield regen.
// Only one mod can be active on an actor at a time — applying a new one removes the old.

const REGEN_MOD_TIERS = [
  { tier: 1, pct: 50,  mult: 1.5, level: 3,  price: 600,   name: 'Shield Regen Mod — Tier 1' },
  { tier: 2, pct: 100, mult: 2.0, level: 6,  price: 2500,  name: 'Shield Regen Mod — Tier 2' },
  { tier: 3, pct: 150, mult: 2.5, level: 9,  price: 7000,  name: 'Shield Regen Mod — Tier 3' },
  { tier: 4, pct: 200, mult: 3.0, level: 12, price: 16000, name: 'Shield Regen Mod — Tier 4' },
];

async function createRegenModEffects() {
  if (!game.user.isGM) {
    return ui.notifications.warn('ME Shields | Only the GM can create regen mod effects.');
  }

  let folder = game.folders.find(f => f.name === 'Mass Effect Mods' && f.type === 'Item');
  if (!folder) {
    folder = await Folder.create({ name: 'Mass Effect Mods', type: 'Item', color: '#80cbc4' });
  }

  for (const mod of REGEN_MOD_TIERS) {
    await Item.create({
      name: mod.name,
      type: 'equipment',
      img: 'icons/magic/defensive/shield-barrier-flaming-diamond-blue-yellow.webp',
      folder: folder.id,
      flags: {
        [MODULE_ID]: { regenMult: mod.mult },
      },
      system: {
        slug: `me-shield-regen-mod-t${mod.tier}`,
        description: {
          value:
            `<p>A Tier ${mod.tier} armor modification that boosts kinetic shield`
            + ` recharge rate by <strong>+${mod.pct}%</strong>`
            + ` (base 10 → ${Math.round(10 * mod.mult)} HP/turn).</p>`
            + `<p>Only one Shield Regen Mod can be installed at a time.</p>`,
        },
        level:   { value: mod.level },
        price:   { value: { sp: mod.price } },
        bulk:    { value: 0 },
        size:    'tiny',
        equipped: { carryType: 'worn', inSlot: true },
        usage:   { value: 'other' },
        traits:  { value: [], rarity: 'common' },
        rules:   [],
      },
    });
  }

  ui.notifications.info(
    `ME Shields | Created ${REGEN_MOD_TIERS.length} Shield Regen Mod items in your Items directory.`
  );
}

// ── AUTO-SYNC ─────────────────────────────────────────────────────────────────
//
// Called automatically on `ready` (GM only). Recreates world-item templates
// whenever the module version changes, so GMs never need to run console commands
// after an update. No-ops if the version hasn't changed since the last sync.
//
// Can also be triggered manually: MassEffectShields.sync()

async function syncEffects(version, { force = false } = {}) {
  const lastVersion = game.settings.get(MODULE_ID, 'lastSyncedVersion');
  if (!force && lastVersion === version) {
    console.log(`ME Shields | Effects already synced for v${version} — skipping (pass true to force)`);
    return;
  }

  console.log(`ME Shields | Syncing effects for v${version}…`);

  // Delete all world items that belong to this module
  const stale = game.items.filter(i => {
    const f = i.flags?.[MODULE_ID];
    return f && (f.shieldMax != null || f.barrier === true || f.barrierMax != null || f.regenMult != null || f.shieldHpBonus != null);
  });
  for (const item of stale) await item.delete();

  // Remove now-empty ME folders
  for (const folderName of ['Mass Effect Shields', 'Mass Effect Barriers', 'Mass Effect Mods']) {
    const folder = game.folders.find(f => f.name === folderName && f.type === 'Item');
    if (folder && folder.contents.length === 0) await folder.delete();
  }

  await createShieldEffects();
  await createBarrierEffects();
  await createShieldHpModEffects();
  await createRegenModEffects();
  await game.settings.set(MODULE_ID, 'lastSyncedVersion', version);
  console.log(`ME Shields | Sync complete.`);
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

  const hpMod = getShieldHpMod(actor);
  if (hpMod) {
    const bonus = hpMod.getFlag(MODULE_ID, 'shieldHpBonus') ?? '(not set)';
    console.log('Shield HP mod:', hpMod.name, `| slug: ${hpMod.system?.slug}`);
    console.log(`  shieldHpBonus=${bonus}`);
  } else {
    console.log('No shield HP mod on actor.');
  }

  const regenMod = getRegenMod(actor);
  if (regenMod) {
    const mult = regenMod.getFlag(MODULE_ID, 'regenMult') ?? '(not set)';
    console.log('Regen mod effect:', regenMod.name, `| slug: ${regenMod.system?.slug}`);
    console.log(`  regenMult=${mult}`);
  } else {
    console.log('No regen mod effect on actor.');
  }

  const coverSlug = game.settings.get(MODULE_ID, 'takeCoverSlug');
  const inCover   = hasTakeCover(actor);
  console.log(`Take Cover slug setting: "${coverSlug}" — actor has cover: ${inCover}`);
  console.groupEnd();
}

globalThis.MassEffectShields = {
  createShieldEffects,
  createShieldHpModEffects,
  createRegenModEffects,
  createBarrierEffects,
  sync:  (force = false) => syncEffects(game.modules.get(MODULE_ID)?.version ?? '?', { force }),
  debug: debugShields,
};
