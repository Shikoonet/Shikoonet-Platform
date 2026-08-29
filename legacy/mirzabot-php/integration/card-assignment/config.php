<?php
declare(strict_types=1);

/** Temporary card lease duration (seconds). Single source of truth — do not duplicate 600 elsewhere. */
const CARD_LEASE_TTL_SECONDS = 600;

/** While a card is ACTIVE for one user, no other user may receive it. */
const MAX_ACTIVE_LEASES_PER_CARD = 1;
