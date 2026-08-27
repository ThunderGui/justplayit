import { many, one, run, transaction } from '../db/index.js';
import { nowIso } from '../util/datetime.js';
import { generateUniqueCode, normaliseCode } from '../util/ids.js';
import { addLedgerEntry, balanceFor } from './ledger.js';
import type { PaymentConfirmationMode } from './settings.js';
import { getSettings } from './settings.js';
import type { User } from './users.js';

export type ClaimStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface PaymentClaim {
  id: number;
  code: string;
  from_user_id: number;
  to_user_id: number;
  amount_cents: number;
  currency: string;
  booking_id: number | null;
  proof_path: string | null;
  status: ClaimStatus;
  claimed_by: number;
  resolved_by: number | null;
  resolved_at: string | null;
  ledger_entry_id: number | null;
  created_at: string;
}

/**
 * Whether `claimant` may turn a claimed payment into a ledger fact on their own.
 * Anyone who cannot still gets to file the claim — it just waits for the
 * receiver to approve it.
 */
export function mayConfirm(
  claimantId: number,
  isAdmin: boolean,
  fromUserId: number,
  toUserId: number,
  mode: PaymentConfirmationMode = getSettings().paymentConfirmationMode,
): boolean {
  if (isAdmin) return true;
  switch (mode) {
    // Only the person who actually received the money can vouch for it.
    case 'receiver':
      return claimantId === toUserId;
    // Either party to the transfer may vouch for it.
    case 'both':
      return claimantId === fromUserId || claimantId === toUserId;
    // Anyone in the group can vouch (loosest; useful for small trusted groups).
    case 'anyone':
      return true;
    default:
      return false;
  }
}

export function findClaimByCode(code: string): PaymentClaim | undefined {
  return one<PaymentClaim>('SELECT * FROM payment_claims WHERE code = ?', normaliseCode(code));
}

export function listPendingClaimsFor(userId: number): PaymentClaim[] {
  return many<PaymentClaim>(
    `SELECT * FROM payment_claims WHERE status = 'PENDING' AND to_user_id = ? ORDER BY created_at`,
    userId,
  );
}

export function listPendingClaims(): PaymentClaim[] {
  return many<PaymentClaim>(
    `SELECT * FROM payment_claims WHERE status = 'PENDING' ORDER BY created_at`,
  );
}

/** How much `fromUserId` currently owes `toUserId`, netted. 0 if nothing. */
export function amountOwed(fromUserId: number, toUserId: number): number {
  const entry = balanceFor(fromUserId).find((b) => b.otherUserId === toUserId);
  return entry && entry.cents > 0 ? entry.cents : 0;
}

export type ClaimResult =
  | { ok: true; status: 'APPROVED'; claim: PaymentClaim; remainingCents: number }
  | { ok: true; status: 'PENDING'; claim: PaymentClaim; approverUserId: number }
  | { ok: false; reason: 'proof_required' | 'nothing_owed' | 'invalid_amount' | 'self_payment' };

/**
 * Records "I paid X". Depending on the admin's confirmation policy this either
 * lands in the ledger immediately or waits for the receiver to approve.
 */
export function claimPayment(input: {
  claimant: User;
  claimantIsAdmin: boolean;
  fromUserId: number;
  toUserId: number;
  amountCents?: number;
  bookingId?: number | null;
  proofPath?: string | null;
}): ClaimResult {
  const settings = getSettings();

  if (input.fromUserId === input.toUserId) return { ok: false, reason: 'self_payment' };

  const owed = amountOwed(input.fromUserId, input.toUserId);
  const amountCents = input.amountCents ?? owed;

  if (amountCents <= 0) {
    return { ok: false, reason: owed <= 0 ? 'nothing_owed' : 'invalid_amount' };
  }
  if (settings.requirePaymentProof && !input.proofPath) {
    return { ok: false, reason: 'proof_required' };
  }

  return transaction<ClaimResult>(() => {
    const approvedNow = mayConfirm(
      input.claimant.id,
      input.claimantIsAdmin,
      input.fromUserId,
      input.toUserId,
      settings.paymentConfirmationMode,
    );

    const code = generateUniqueCode(
      (candidate) => one('SELECT 1 AS x FROM payment_claims WHERE code = ?', candidate) != null,
    );

    const { lastInsertRowid } = run(
      `INSERT INTO payment_claims
         (code, from_user_id, to_user_id, amount_cents, currency, booking_id,
          proof_path, status, claimed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      code,
      input.fromUserId,
      input.toUserId,
      amountCents,
      settings.currency,
      input.bookingId ?? null,
      input.proofPath ?? null,
      approvedNow ? 'APPROVED' : 'PENDING',
      input.claimant.id,
      nowIso(),
    );

    const claim = one<PaymentClaim>('SELECT * FROM payment_claims WHERE id = ?', lastInsertRowid)!;

    if (!approvedNow) {
      return { ok: true, status: 'PENDING', claim, approverUserId: input.toUserId };
    }

    const entry = addLedgerEntry({
      kind: 'PAYMENT',
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      amountCents,
      currency: settings.currency,
      bookingId: input.bookingId ?? null,
      note: `Payment ${code}`,
      createdBy: input.claimant.id,
    });

    run(
      `UPDATE payment_claims
          SET ledger_entry_id = ?, resolved_by = ?, resolved_at = ?
        WHERE id = ?`,
      entry.id,
      input.claimant.id,
      nowIso(),
      claim.id,
    );

    return {
      ok: true,
      status: 'APPROVED',
      claim: one<PaymentClaim>('SELECT * FROM payment_claims WHERE id = ?', claim.id)!,
      remainingCents: amountOwed(input.fromUserId, input.toUserId),
    };
  });
}

export type ResolveResult =
  | { ok: true; claim: PaymentClaim; remainingCents: number }
  | { ok: false; reason: 'not_found' | 'not_allowed' | 'already_resolved' };

/** Receiver (or admin) approves a pending claim, writing it to the ledger. */
export function approveClaim(code: string, actor: User, actorIsAdmin: boolean): ResolveResult {
  return transaction<ResolveResult>(() => {
    const claim = findClaimByCode(code);
    if (!claim) return { ok: false, reason: 'not_found' };
    if (claim.status !== 'PENDING') return { ok: false, reason: 'already_resolved' };
    if (!actorIsAdmin && actor.id !== claim.to_user_id) return { ok: false, reason: 'not_allowed' };

    const entry = addLedgerEntry({
      kind: 'PAYMENT',
      fromUserId: claim.from_user_id,
      toUserId: claim.to_user_id,
      amountCents: claim.amount_cents,
      currency: claim.currency,
      bookingId: claim.booking_id,
      note: `Payment ${claim.code}`,
      createdBy: actor.id,
    });

    run(
      `UPDATE payment_claims
          SET status = 'APPROVED', ledger_entry_id = ?, resolved_by = ?, resolved_at = ?
        WHERE id = ?`,
      entry.id,
      actor.id,
      nowIso(),
      claim.id,
    );

    return {
      ok: true,
      claim: findClaimByCode(claim.code)!,
      remainingCents: amountOwed(claim.from_user_id, claim.to_user_id),
    };
  });
}

export function rejectClaim(code: string, actor: User, actorIsAdmin: boolean): ResolveResult {
  const claim = findClaimByCode(code);
  if (!claim) return { ok: false, reason: 'not_found' };
  if (claim.status !== 'PENDING') return { ok: false, reason: 'already_resolved' };
  if (!actorIsAdmin && actor.id !== claim.to_user_id) return { ok: false, reason: 'not_allowed' };

  run(
    `UPDATE payment_claims SET status = 'REJECTED', resolved_by = ?, resolved_at = ? WHERE id = ?`,
    actor.id,
    nowIso(),
    claim.id,
  );

  return { ok: true, claim: findClaimByCode(claim.code)!, remainingCents: 0 };
}
