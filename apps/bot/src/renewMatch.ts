/**
 * Which of a panel's plans a service should be renewed onto — or none.
 *
 * Sam, 2026-09-11: «وقتی بخش تمدید رو کلیک میکنه و اکانتی که میخواد تمدید کنه
 * رو انتخاب میکنه باید همونجا redirect بشه به پلن متناسب همون اکانتش». The
 * screen after picking a service was the panel's whole flat list, because the
 * plan a migrated service was sold under is gone for half of them
 * (`owned.ts`). That stays true for those; for a service that remembers, the
 * list was eight buttons hiding the one that mattered.
 *
 * Three steps, each taken only when it is certain:
 *
 * 1. `plan_id` — written on every fresh sale and every renewal, so a service
 *    bought or renewed on this bot always has it. If that plan is still on
 *    offer, it IS the answer.
 * 2. The same size and length — for the migrated rows, where `plan_id` is
 *    NULL but `volume_gb`/`duration_days` survived the import. Only when
 *    exactly ONE plan on the panel fits: two 50 GB/30-day plans at two prices
 *    is a choice, and choosing it here would be choosing the customer's money
 *    for them.
 * 3. The name it was sold under, exactly — same rule, exactly one.
 *
 * Otherwise null, and the caller shows the list it always showed. Guessing is
 * the one thing this function never does: a wrong «matching» plan is a wrong
 * invoice.
 */

import type { CatalogPlan } from './catalog.js';
import { soldAs } from './menu.js';

export interface RenewalSale {
  plan_id: number | null;
  plan_name_at_sale: string;
  volume_gb: number | null;
  duration_days: number | null;
}

export function matchingRenewalPlan(service: RenewalSale, plans: CatalogPlan[]): CatalogPlan | null {
  if (service.plan_id !== null) {
    const remembered = plans.find((p) => p.planId === service.plan_id);
    if (remembered) return remembered;
  }
  if (service.volume_gb !== null && service.duration_days !== null) {
    const same = plans.filter(
      (p) => p.volumeGb === service.volume_gb && p.durationDays === service.duration_days,
    );
    if (same.length === 1) return same[0]!;
  }
  const name = service.plan_name_at_sale.trim();
  if (name !== '') {
    const named = plans.filter(
      (p) => soldAs(p.productName, p.planName) === name || p.planName.trim() === name,
    );
    if (named.length === 1) return named[0]!;
  }
  return null;
}
