/**
 * Manual fulfilment — a human does it.
 *
 * This is what a product is sold through when there is nothing to automate yet:
 * an account someone opens by hand, a service with no API, a panel type whose
 * adapter is not written. It exists so that the answer to "we do not know how
 * to deliver this" is a visible queue rather than an order that succeeds and
 * gives the customer nothing.
 *
 * It reports success on purpose. The money is real and the sale happened; what
 * is outstanding is an action, not a fault, and marking the order FAILED would
 * put it in the same bucket as a panel that is down.
 */

import type {
  ProviderContext,
  ProvisionRequest,
  ProvisionResult,
  ProvisioningAdapter,
} from './types.js';

export const manualAdapter: ProvisioningAdapter = {
  kind: 'manual',

  provision(request: ProvisionRequest, provider: ProviderContext): Promise<ProvisionResult> {
    return Promise.resolve({
      ok: true,
      remoteUsername: request.username,
      // `pending: true` is what a "waiting for a human" list is built from, and
      // it is inside remote_ref because it is this adapter's business alone.
      remoteRef: { provider: provider.code, pending: true, kind: 'manual' },
      // Nothing to link to. The caller must not promise the customer a config
      // it does not have — see `menu.serviceBeingPrepared`.
      subscriptionUrl: null,
      alreadyExisted: false,
    });
  },
};
