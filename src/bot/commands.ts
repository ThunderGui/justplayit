import { DateTime } from 'luxon';
import {
  cancelBooking,
  cancellationDeadline,
  createBooking,
  createExternalBooking,
  findBookingByCode,
  getRoster,
  isExternal,
  joinBooking,
  leaveBooking,
  listUpcoming,
  placeLabel,
  type Booking,
} from '../domain/bookings.js';
import { balanceFor, overallBalances, settleBooking, simplifyDebts } from '../domain/ledger.js';
import { approveClaim, claimPayment, rejectClaim } from '../domain/payments.js';
import { setPending, takePending } from '../domain/pending.js';
import { cooldownRemainingHours, pendingReminders, recordReminder } from '../domain/reminders.js';
import { listMembers } from '../domain/groups.js';
import { listPlaces, resolvePlace } from '../domain/places.js';
import type { Settings } from '../domain/settings.js';
import { getSettings } from '../domain/settings.js';
import {
  anonymiseUser,
  displayName,
  findUserById,
  listUsers,
  type User,
} from '../domain/users.js';
import type { Dict } from '../i18n/index.js';
import { formatDateTime, nowIso, parseDateTime, parseDuration, toUtcIso } from '../util/datetime.js';
import { formatMoney, parseMoneyToCents } from '../util/money.js';
import { balanceCard, bookingCard, bookingList } from './render.js';
import { field, type ParsedCommand } from './parser.js';
import { helpText } from './help.js';
import { run } from '../db/index.js';

/* ------------------------------------------------------------------ */
/* Message plumbing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Where a reply goes.
 *  - `origin` : back to whichever chat the command came from
 *  - `group`  : the group, so everyone can follow along (the design's rule)
 *  - `dm`     : privately to one user, whatever chat they asked from
 */
export type ReplyTarget = 'origin' | 'group' | 'dm';

export interface OutgoingMessage {
  target: ReplyTarget;
  text: string;
  /** Required when target is `dm`. */
  userId?: number;
  /** Users to @-mention, so WhatsApp pushes a notification to them. */
  mentionUserIds?: number[];
}

export interface CommandContext {
  /** The group this message belongs to. Every read and write is scoped to it. */
  groupId: number;
  user: User;
  /** True for a WhatsApp group admin, or the web-console superadmin. */
  isAdmin: boolean;
  /** The chat the message arrived in. */
  chatId: string;
  isGroup: boolean;
  dict: Dict;
  settings: Settings;
  /** Users @-mentioned in the message, already resolved. */
  mentionedUserIds: number[];
  /** Path to a saved attachment, if the message carried one. */
  attachmentPath?: string | null;
}

const reply = (text: string): OutgoingMessage => ({ target: 'origin', text });
const toGroup = (text: string, mentionUserIds?: number[]): OutgoingMessage => ({
  target: 'group',
  text,
  mentionUserIds,
});
const toDm = (userId: number, text: string): OutgoingMessage => ({
  target: 'dm',
  userId,
  text,
});

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export function handleCommand(cmd: ParsedCommand, ctx: CommandContext): OutgoingMessage[] {
  switch (cmd.name) {
    case 'help': {
      const text = helpText(ctx.dict, ctx.settings, ctx.isAdmin);
      // Admins get the fuller, admin-only help privately — it lists privileged
      // commands the rest of the group has no use seeing, and keeps the group
      // chat uncluttered. Non-admins get it where they asked.
      if (ctx.isAdmin) {
        return ctx.isGroup
          ? [toDm(ctx.user.id, text), reply(ctx.dict.common.sentPrivately)]
          : [toDm(ctx.user.id, text)];
      }
      return [reply(text)];
    }
    case 'list':
      return handleList(ctx);
    case 'show':
      return handleShow(cmd, ctx);
    case 'book':
      return handleBook(cmd, ctx);
    case 'external':
      return handleExternal(cmd, ctx);
    case 'cancel':
      return handleCancel(cmd, ctx);
    case 'join':
      return handleJoin(cmd, ctx);
    case 'leave':
      return handleLeave(cmd, ctx);
    case 'yes':
      return handleYes(ctx);
    case 'no':
      return handleNo(ctx);
    case 'confirm':
      return handleConfirm(cmd, ctx);
    case 'approve':
      return handleApproveReject(cmd, ctx, 'approve');
    case 'reject':
      return handleApproveReject(cmd, ctx, 'reject');
    case 'balance':
      return handleBalance(ctx);
    case 'remind':
      return handleRemind(cmd, ctx);
    case 'settle':
      return handleSettle(cmd, ctx);
    case 'report':
      return handleReport(cmd, ctx);
    case 'privacy':
      return [toDm(ctx.user.id, ctx.dict.misc.privacyNotice(ctx.settings.commandPrefix))];
    case 'forgetme':
      return handleForgetMe(ctx);
    default:
      return [reply(ctx.dict.common.unknownCommand(cmd.raw, ctx.settings.commandPrefix))];
  }
}

/* ------------------------------------------------------------------ */
/* list / show                                                         */
/* ------------------------------------------------------------------ */

function handleList(ctx: CommandContext): OutgoingMessage[] {
  return [reply(bookingList(listUpcoming(ctx.groupId), ctx.dict, ctx.settings))];
}

function handleShow(cmd: ParsedCommand, ctx: CommandContext): OutgoingMessage[] {
  const code = cmd.args[0];
  if (!code) {
    return [reply(ctx.dict.common.usage(`${ctx.settings.commandPrefix}show <id>`))];
  }

  const booking = findBookingByCode(code);
  if (!booking) return [reply(ctx.dict.booking.notFound(code.toUpperCase()))];

  return [reply(bookingCard(booking, ctx.dict))];
}

/* ------------------------------------------------------------------ */
/* book                                                                */
/* ------------------------------------------------------------------ */

/** Field names shown when a booking command is missing something. */
const BOOK_TEMPLATE = (prefix: string) =>
  [
    `${prefix}book`,
    'place: Padel Base',
    'date: 03/09',
    'time: 19:00',
    'cost: 40',
    'max: 4',
  ].join('\n');

function handleBook(cmd: ParsedCommand, ctx: CommandContext): OutgoingMessage[] {
  const { dict, settings } = ctx;
  const f = cmd.fields;

  // Bare `!book` shows the template rather than starting a slow Q&A wizard —
  // one message to fill in beats six round trips in a busy group chat.
  if (f.size === 0) {
    return [reply(`${dict.booking.missingFields('place, date, time, cost')}\n\n${BOOK_TEMPLATE(settings.commandPrefix)}`)];
  }

  const missing: string[] = [];
  const placeInput = field(f, 'place');
  const dateInput = field(f, 'date');
  const timeInput = field(f, 'time');
  const costInput = field(f, 'cost');

  if (!placeInput) missing.push('place');
  if (!dateInput) missing.push('date');
  if (!timeInput) missing.push('time');
  if (!costInput) missing.push('cost');
  if (missing.length > 0) {
    return [reply(`${dict.booking.missingFields(missing.join(', '))}\n\n${BOOK_TEMPLATE(settings.commandPrefix)}`)];
  }

  const place = resolveBookingPlace(placeInput!, ctx);
  if ('error' in place) return [reply(place.error)];

  const startsAt = parseDateTime(dateInput!, timeInput!, settings.timezone);
  if (!startsAt) {
    return [reply(parseDateTime(dateInput!, '12:00', settings.timezone) ? dict.booking.badTime : dict.booking.badDate)];
  }

  const totalCostCents = parseMoneyToCents(costInput!);
  if (totalCostCents == null) return [reply(dict.booking.badCost)];

  const maxPlayers = toPositiveInt(field(f, 'max')) ?? settings.defaultMaxPlayers;
  const minPlayers = toPositiveInt(field(f, 'min')) ?? Math.min(settings.defaultMinPlayers, maxPlayers);
  const durationMin = field(f, 'duration') ? parseDuration(field(f, 'duration')!) : undefined;
  const cancelHours = toPositiveInt(field(f, 'cancel'));

  const result = createBooking({
    groupId: ctx.groupId,
    creator: ctx.user,
    startsAtIso: toUtcIso(startsAt),
    durationMin: durationMin ?? undefined,
    totalCostCents,
    minPlayers,
    maxPlayers,
    placeId: place.placeId,
    customPlace: place.customPlace,
    court: field(f, 'court') ?? null,
    notes: field(f, 'notes') ?? null,
    cancelLimitHours: cancelHours ?? null,
  });

  if (!result.ok) return [reply(bookingErrorText(result.reason, ctx, result))];

  return [
    toGroup(`${dict.booking.created(result.booking.code)}\n\n${bookingCard(result.booking, dict)}`),
  ];
}

/* ------------------------------------------------------------------ */
/* external (Playtomic)                                                */
/* ------------------------------------------------------------------ */

const EXTERNAL_TEMPLATE = (prefix: string) =>
  `${prefix}playtomic <link> — just paste the Playtomic link; the rest is read from it.`;

function handleExternal(cmd: ParsedCommand, ctx: CommandContext): OutgoingMessage[] {
  const { dict, settings } = ctx;
  const f = cmd.fields;

  // A bare URL is enough to spot the link even without the `url:` label.
  const urlInput = field(f, 'url') ?? cmd.args.find((a) => /^https?:\/\//i.test(a));
  const dateInput = field(f, 'date');
  const timeInput = field(f, 'time');

  if (!urlInput || !dateInput || !timeInput) {
    const missing = [
      !urlInput ? 'url' : null,
      !dateInput ? 'date' : null,
      !timeInput ? 'time' : null,
    ].filter(Boolean) as string[];
    return [
      reply(`${dict.booking.missingFields(missing.join(', '))}\n\n${EXTERNAL_TEMPLATE(settings.commandPrefix)}`),
    ];
  }

  const startsAt = parseDateTime(dateInput, timeInput, settings.timezone);
  if (!startsAt) return [reply(dict.booking.badDate)];

  // The place is optional for an external booking — the link carries it.
  let placeId: number | null = null;
  let customPlace: string | null = null;
  const placeInput = field(f, 'place');
  if (placeInput) {
    const resolved = resolveBookingPlace(placeInput, ctx);
    if ('error' in resolved) return [reply(resolved.error)];
    placeId = resolved.placeId;
    customPlace = resolved.customPlace;
  }

  const provider = field(f, 'provider') ?? providerFromUrl(urlInput);
  const durationMin = field(f, 'duration') ? parseDuration(field(f, 'duration')!) : undefined;

  const result = createExternalBooking({
    groupId: ctx.groupId,
    creator: ctx.user,
    provider,
    url: urlInput,
    startsAtIso: toUtcIso(startsAt),
    durationMin: durationMin ?? undefined,
    placeId,
    customPlace,
    court: field(f, 'court') ?? null,
    notes: field(f, 'notes') ?? null,
  });

  if (!result.ok) {
    if (result.reason === 'bad_url') return [reply(dict.external.badUrl)];
    return [reply(bookingErrorText(result.reason, ctx, result))];
  }

  return [
    toGroup(
      `${dict.external.created(result.booking.code, provider)}\n\n${bookingCard(result.booking, dict)}`,
    ),
  ];
}

/** Best-effort provider name from the link's host: playtomic.io → Playtomic. */
function providerFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const stem = host.split('.')[0] ?? host;
    return stem.charAt(0).toUpperCase() + stem.slice(1);
  } catch {
    return 'External';
  }
}

/* ------------------------------------------------------------------ */
/* cancel                                                              */
/* ------------------------------------------------------------------ */

function handleCancel(cmd: ParsedCommand, ctx: CommandContext): OutgoingMessage[] {
  const code = cmd.args[0];
  if (!code) return [reply(ctx.dict.common.usage(`${ctx.settings.commandPrefix}cancel <id>`))];

  const result = cancelBooking(code, ctx.user, ctx.isAdmin);
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return [reply(ctx.dict.booking.notFound(code.toUpperCase()))];
      case 'not_allowed':
        return [reply(ctx.dict.booking.cancelNotAllowed)];
      case 'already_cancelled':
        return [reply(ctx.dict.booking.alreadyCancelled)];
      case 'already_settled':
        return [reply(ctx.dict.booking.alreadySettled)];
    }
  }

  return [
    toGroup(
      ctx.dict.booking.cancelled(result.booking.code, displayName(ctx.user)),
      result.notifyUserIds,
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* join / leave                                                        */
/* ------------------------------------------------------------------ */

/** With one booking coming up, `!join` alone is unambiguous — don't demand an id. */
function resolveTargetBooking(cmd: ParsedCommand, groupId: number): Booking | 'none' | 'ambiguous' {
  const code = cmd.args[0];
  if (code) return findBookingByCode(code) ?? 'none';

  const upcoming = listUpcoming(groupId).filter((b) => !isExternal(b));
  if (upcoming.length === 1) return upcoming[0]!;
  return upcoming.length === 0 ? 'none' : 'ambiguous';
}

function handleJoin(cmd: ParsedCommand, ctx: CommandContext): OutgoingMessage[] {
  const { dict } = ctx;
  const target = resolveTargetBooking(cmd, ctx.groupId);

  if (target === 'none') {
    return [reply(cmd.args[0] ? dict.booking.notFound(cmd.args[0].toUpperCase()) : dict.booking.listEmpty(ctx.settings.commandPrefix))];
  }
  if (target === 'ambiguous') {
    return [reply(`${dict.common.usage(`${ctx.settings.commandPrefix}join <id>`)}\n\n${bookingList(listUpcoming(ctx.groupId), dict, ctx.settings)}`)];
  }

  const result = joinBooking(target.code, ctx.user);
  if (!result.ok) {
    switch (result.reason) {
      case 'external':
        return [reply(dict.external.rosterNotTracked(target.code, target.external_provider ?? 'the platform'))];
      case 'already_in':
        return [reply(dict.roster.alreadyIn(target.code))];
      case 'already_waiting': {
        const position = getRoster(target.id).waitlist.findIndex((p) => p.user_id === ctx.user.id) + 1;
        return [reply(dict.roster.alreadyWaiting(target.code, position))];
      }
      case 'cancelled':
        return [reply(dict.booking.alreadyCancelled)];
      case 'settled':
        return [reply(dict.booking.alreadySettled)];
      case 'past':
        return [reply(dict.roster.bookingPast)];
      default:
        return [reply(dict.booking.notFound(target.code))];
    }
  }

  const name = displayName(ctx.user);
  const roster = getRoster(result.booking.id);

  if (result.outcome === 'waitlisted') {
    return [toGroup(dict.roster.waitlisted(name, result.booking.code, result.position))];
  }

  const full = roster.confirmed.length >= result.booking.max_players;
  const text = full
    ? dict.roster.joinedFull(name, result.booking.code)
    : dict.roster.joined(name, result.booking.code, roster.confirmed.length, result.booking.max_players);

  return [
    toGroup(text),
    // The calendar link is personal, so it goes to the joiner rather than
    // adding another long URL to the group thread.
    toDm(
      ctx.user.id,
      `${dict.label.addToCalendar}:\n${bookingCard(result.booking, dict)}`,
    ),
  ];
}

function handleLeave(cmd: ParsedCommand, ctx: CommandContext): OutgoingMessage[] {
  const { dict } = ctx;
  const target = resolveTargetBooking(cmd, ctx.groupId);

  if (target === 'none') {
    return [reply(cmd.args[0] ? dict.booking.notFound(cmd.args[0].toUpperCase()) : dict.booking.listEmpty(ctx.settings.commandPrefix))];
  }
  if (target === 'ambiguous') {
    return [reply(dict.common.usage(`${ctx.settings.commandPrefix}leave <id>`))];
  }

  return applyLeave(target, ctx, false);
}

function applyLeave(
  booking: Booking,
  ctx: CommandContext,
  confirmLate: boolean,
): OutgoingMessage[] {
  const { dict } = ctx;
  const result = leaveBooking(booking.code, ctx.user, confirmLate);

  if (!result.ok) {
    switch (result.reason) {
      case 'external':
        return [reply(dict.external.rosterNotTracked(booking.code, booking.external_provider ?? 'the platform'))];
      case 'not_in':
        return [reply(dict.roster.notIn(booking.code))];
      case 'cancelled':
        return [reply(dict.booking.alreadyCancelled)];
      case 'settled':
        return [reply(dict.booking.alreadySettled)];
      default:
        return [reply(dict.booking.notFound(booking.code))];
    }
  }

  const name = displayName(ctx.user);

  // The design's rule: a late leave needs a second, explicit confirmation
  // because money may still be owed.
  if (result.outcome === 'needs_late_confirmation') {
    setPending(ctx.user.id, ctx.chatId, 'LATE_LEAVE', { code: booking.code });
    const deadline = formatDateTime(
      cancellationDeadline(booking),
      ctx.settings.timezone,
      ctx.settings.language,
    );
    return [
      reply(
        `${dict.roster.lateLeaveWarning(
          booking.code,
          formatMoney(result.shareEstimateCents, booking.currency),
          deadline,
        )}\n\n${dict.common.confirmYesNo(ctx.settings.commandPrefix)}`,
      ),
    ];
  }

  if (result.outcome === 'left_waitlist') {
    return [toGroup(dict.roster.leftWaitlist(name, booking.code))];
  }

  const messages: OutgoingMessage[] = [];
  const roster = getRoster(booking.id);

  if (result.outcome === 'left') {
    messages.push(
      toGroup(dict.roster.left(name, booking.code, roster.confirmed.length, booking.max_players)),
    );
  } else {
    const replacement = result.promoted ? findUserById(result.promoted.user_id) : undefined;
    messages.push(
      toGroup(
        replacement
          ? dict.roster.lateLeaveReplaced(name, booking.code, displayName(replacement))
          : dict.roster.lateLeaveConfirmed(name, booking.code),
      ),
    );
  }

  if (result.promoted) {
    const promotedUser = findUserById(result.promoted.user_id);
    messages.push(
      toGroup(dict.roster.promoted(displayName(promotedUser), booking.code), [
        result.promoted.user_id,
      ]),
    );
  } else if (roster.confirmed.length < booking.max_players) {
    messages.push(
      toGroup(
        dict.roster.spotOpen(
          booking.code,
          roster.confirmed.length,
          booking.max_players,
          ctx.settings.commandPrefix,
        ),
      ),
    );
  }

  return messages;
}

/* ------------------------------------------------------------------ */
/* yes / no                                                            */
/* ------------------------------------------------------------------ */

function handleYes(ctx: CommandContext): OutgoingMessage[] {
  const pending = takePending<{ code?: string }>(ctx.user.id, ctx.chatId);
  if (!pending) return [reply(ctx.dict.common.nothingPending)];

  if (pending.kind === 'LATE_LEAVE') {
    const booking = pending.payload.code ? findBookingByCode(pending.payload.code) : undefined;
    if (!booking) return [reply(ctx.dict.booking.notFound(pending.payload.code ?? '?'))];
    return applyLeave(booking, ctx, true);
  }

  if (pending.kind === 'FORGET_ME') {
    anonymiseUser(ctx.user.id);
    return [reply(ctx.dict.misc.forgotten)];
  }

  return [reply(ctx.dict.common.nothingPending)];
}

function handleNo(ctx: CommandContext): OutgoingMessage[] {
  const pending = takePending(ctx.user.id, ctx.chatId);
  return [reply(pending ? ctx.dict.common.cancelled : ctx.dict.common.nothingPending)];
}

/* ------------------------------------------------------------------ */
/* confirm / approve / reject                                          */
/* ------------------------------------------------------------------ */

function handleConfirm(cmd: ParsedCommand, ctx: CommandContext): OutgoingMessage[] {
  const { dict } = ctx;

  // Who was paid: an @-mention wins, otherwise a name typed as text.
  let targetUserId = ctx.mentionedUserIds[0];
  const textArgs = cmd.args.filter((a) => !a.startsWith('@'));

  if (targetUserId == null) {
    const nameGuess = textArgs.filter((a) => parseMoneyToCents(a) == null).join(' ');
    if (nameGuess) {
      const matched = matchUsersByName(nameGuess, ctx.user.id, ctx.groupId);
      if (matched.length === 1) targetUserId = matched[0]!.id;
      else if (matched.length > 1) {
        return [reply(dict.common.ambiguousUser(matched.map((u) => displayName(u))))];
      }
    }
  }

  // With nobody named and exactly one open debt, the intent is unambiguous.
  const myBalance = balanceFor(ctx.user.id, ctx.groupId).filter((b) => b.cents > 0);
  if (targetUserId == null) {
    if (myBalance.length === 1) targetUserId = myBalance[0]!.otherUserId;
    else if (myBalance.length === 0) return [privateReply(ctx, dict.payment.balanceAllClear)];
    else {
      return [
        privateReply(
          ctx,
          `${dict.common.usage(`${ctx.settings.commandPrefix}confirm <name> [amount]`)}\n\n` +
            balanceCard(balanceFor(ctx.user.id, ctx.groupId), dict, ctx.settings.currency),
        ),
      ];
    }
  }

  if (targetUserId == null) return [reply(dict.common.noSuchUser)];

  const amountArg = cmd.args.map((a) => parseMoneyToCents(a)).find((c) => c != null);

  // Work out which way the money went from the netted balance: `!confirm X`
  // means "I paid X" when I owe them, and "X paid me" when they owe me. Without
  // this the person receiving money could never record a payment, which is what
  // the receiver-only and dual policies rely on.
  const netWithTarget =
    balanceFor(ctx.user.id, ctx.groupId).find((b) => b.otherUserId === targetUserId)?.cents ?? 0;
  const iAmThePayer = netWithTarget > 0;

  const result = claimPayment({
    groupId: ctx.groupId,
    claimant: ctx.user,
    claimantIsAdmin: ctx.isAdmin,
    fromUserId: iAmThePayer ? ctx.user.id : targetUserId,
    toUserId: iAmThePayer ? targetUserId : ctx.user.id,
    amountCents: amountArg ?? undefined,
    proofPath: ctx.attachmentPath ?? null,
  });

  if (!result.ok) {
    switch (result.reason) {
      case 'proof_required':
        return [reply(dict.payment.proofRequired)];
      case 'nothing_owed':
        return [reply(dict.payment.nothingOwed(displayName(findUserById(targetUserId))))];
      case 'self_payment':
        return [reply(dict.payment.selfPayment)];
      default:
        return [reply(dict.payment.invalidAmount)];
    }
  }

  const payer = findUserById(result.claim.from_user_id);
  const receiver = findUserById(result.claim.to_user_id);
  const amountText = formatMoney(result.claim.amount_cents, result.claim.currency);

  if (result.status === 'PENDING') {
    // Under the strictest policy the receiver can be the one filing the claim,
    // in which case it is the *sender* who has to sign off — and the wording
    // has to flip with it.
    const approverIsSender = result.approverUserId === result.claim.from_user_id;

    const request = approverIsSender
      ? dict.payment.approvalRequestToSender(
          result.claim.code,
          displayName(ctx.user),
          amountText,
          ctx.settings.commandPrefix,
        )
      : dict.payment.approvalRequest(
          result.claim.code,
          displayName(ctx.user),
          amountText,
          ctx.settings.commandPrefix,
        );

    return [
      // Answer where it was asked, per the design's channel rule.
      reply(dict.payment.pending(result.claim.code, displayName(receiver), amountText)),
      toDm(result.approverUserId, request),
    ];
  }

  const messages: OutgoingMessage[] = [
    reply(
      `${dict.payment.recorded(displayName(payer), displayName(receiver), amountText)}\n` +
        (result.remainingCents > 0
          ? dict.payment.remaining(formatMoney(result.remainingCents, result.claim.currency))
          : dict.payment.settledUp),
    ),
  ];

  // Let the other side know without making the whole group read it.
  if (targetUserId !== ctx.user.id) {
    messages.push(
      toDm(targetUserId, dict.payment.recorded(displayName(payer), displayName(receiver), amountText)),
    );
  }

  return messages;
}

function handleApproveReject(
  cmd: ParsedCommand,
  ctx: CommandContext,
  action: 'approve' | 'reject',
): OutgoingMessage[] {
  const { dict } = ctx;
  const code = cmd.args[0];
  if (!code) {
    return [reply(dict.common.usage(`${ctx.settings.commandPrefix}${action} <payment-id>`))];
  }

  const result =
    action === 'approve'
      ? approveClaim(code, ctx.user, ctx.isAdmin)
      : rejectClaim(code, ctx.user, ctx.isAdmin);

  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return [reply(dict.payment.claimNotFound(code.toUpperCase()))];
      case 'not_allowed':
        return [reply(dict.payment.claimNotAllowed)];
      default:
        return [reply(dict.payment.claimAlreadyResolved)];
    }
  }

  const amountText = formatMoney(result.claim.amount_cents, result.claim.currency);

  if (action === 'reject') {
    return [
      reply(dict.payment.rejected(result.claim.code)),
      toDm(result.claim.from_user_id, dict.payment.rejected(result.claim.code)),
    ];
  }

  return [
    reply(dict.payment.approved(result.claim.code, amountText)),
    toDm(
      result.claim.from_user_id,
      `${dict.payment.approved(result.claim.code, amountText)}\n` +
        (result.remainingCents > 0
          ? dict.payment.remaining(formatMoney(result.remainingCents, result.claim.currency))
          : dict.payment.settledUp),
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* balance                                                             */
/* ------------------------------------------------------------------ */

function handleBalance(ctx: CommandContext): OutgoingMessage[] {
  const { dict, settings } = ctx;

  // The design is explicit: balances are always answered privately.
  const personal = balanceCard(balanceFor(ctx.user.id, ctx.groupId), dict, settings.currency);

  const messages: OutgoingMessage[] = [toDm(ctx.user.id, personal)];

  if (ctx.isAdmin) {
    const overall = overallBalances(ctx.groupId);
    if (overall.length > 0) {
      const lines = [`*${dict.payment.overallHeader}*`, ''];
      for (const row of overall) {
        const name = displayName(findUserById(row.userId));
        lines.push(
          row.netCents > 0
            ? `  ${dict.payment.owesYou(name, formatMoney(row.netCents, settings.currency)).replace(/^.*?:/, `${name} is owed:`)}`
            : `  ${name} owes: ${formatMoney(-row.netCents, settings.currency)}`,
        );
      }

      const transfers = simplifyDebts(ctx.groupId);
      if (transfers.length > 0) {
        lines.push('', `*${dict.payment.suggestedTransfers}*`);
        for (const transfer of transfers) {
          lines.push(
            `  ${dict.payment.transfer(
              displayName(findUserById(transfer.fromUserId)),
              displayName(findUserById(transfer.toUserId)),
              formatMoney(transfer.cents, settings.currency),
            )}`,
          );
        }
      }

      messages.push(toDm(ctx.user.id, lines.join('\n')));
    }
  }

  // Asked in the group: acknowledge there without leaking any figures.
  if (ctx.isGroup) messages.push(reply(dict.common.sentPrivately));

  return messages;
}

/* ------------------------------------------------------------------ */
/* remind                                                              */
/* ------------------------------------------------------------------ */

/**
 * Nudges everyone who owes the sender. Each nudge is a private message to the
 * debtor — a public list of who has not paid is precisely the awkwardness this
 * bot exists to remove — and the summary goes back privately for the same
 * reason, even when the command was typed in the group.
 */
function handleRemind(cmd: ParsedCommand, ctx: CommandContext): OutgoingMessage[] {
  const { dict, settings } = ctx;

  // An optional target: `remind @someone` or `remind Daniel`.
  let onlyUserId = ctx.mentionedUserIds[0];
  const nameGuess = cmd.args.filter((a) => !a.startsWith('@')).join(' ').trim();
  if (onlyUserId == null && nameGuess) {
    const matched = matchUsersByName(nameGuess, ctx.user.id, ctx.groupId);
    if (matched.length === 1) onlyUserId = matched[0]!.id;
    else if (matched.length > 1) {
      return [privateReply(ctx, dict.common.ambiguousUser(matched.map((u) => displayName(u))))];
    } else {
      return [privateReply(ctx, dict.common.noSuchUser)];
    }
  }

  const { due, onCooldown } = pendingReminders(ctx.user.id, ctx.groupId, onlyUserId);

  if (due.length === 0) {
    const text =
      onCooldown.length > 0
        ? dict.payment.remindAllOnCooldown(
            Math.max(...onCooldown.map((t) => cooldownRemainingHours(t.lastRemindedAt!))),
          )
        : dict.payment.remindNobodyOwes;
    return withGroupAck(ctx, [toDm(ctx.user.id, text)]);
  }

  const messages: OutgoingMessage[] = [];
  let total = 0;

  // Re-read the sender: an admin may have set their payment details in the web
  // console since this message's user record was loaded.
  const me = findUserById(ctx.user.id) ?? ctx.user;

  for (const target of due) {
    messages.push(
      toDm(
        target.userId,
        `${dict.payment.remindDebtor(
          displayName(me),
          formatMoney(target.cents, settings.currency),
          settings.commandPrefix,
        )}${me.payment_handle ? `\n${dict.settlement.payHandle(me.payment_handle)}` : ''}`,
      ),
    );
    recordReminder(ctx.user.id, target.userId, target.cents, ctx.groupId);
    total += target.cents;
  }

  const summary = [dict.payment.remindSent(due.length, formatMoney(total, settings.currency))];
  if (onCooldown.length > 0) {
    summary.push(
      dict.payment.remindSkipped(
        onCooldown.map((t) => displayName(findUserById(t.userId))).join(', '),
      ),
    );
  }

  messages.push(toDm(ctx.user.id, summary.join('\n')));
  return withGroupAck(ctx, messages);
}

/** Adds a content-free acknowledgement when a private answer was asked for publicly. */
function withGroupAck(ctx: CommandContext, messages: OutgoingMessage[]): OutgoingMessage[] {
  return ctx.isGroup ? [...messages, reply(ctx.dict.common.sentPrivately)] : messages;
}

/* ------------------------------------------------------------------ */
/* settle                                                              */
/* ------------------------------------------------------------------ */

function handleSettle(cmd: ParsedCommand, ctx: CommandContext): OutgoingMessage[] {
  const { dict } = ctx;
  const code = cmd.args[0];
  if (!code) return [reply(dict.common.usage(`${ctx.settings.commandPrefix}settle <id>`))];

  const booking = findBookingByCode(code);
  if (!booking) return [reply(dict.booking.notFound(code.toUpperCase()))];
  if (booking.creator_id !== ctx.user.id && !ctx.isAdmin) {
    return [reply(dict.booking.cancelNotAllowed)];
  }

  const result = settleBooking(booking.id);
  if (!result.ok) {
    switch (result.reason) {
      case 'external':
        return [reply(dict.external.noBalance(booking.external_provider ?? 'the platform'))];
      case 'already_settled':
        return [reply(dict.booking.alreadySettled)];
      case 'cancelled':
        return [reply(dict.booking.alreadyCancelled)];
      default:
        return [reply(dict.booking.notFound(booking.code))];
    }
  }

  return settlementMessages(result.booking, result.lines, ctx.dict, ctx.settings);
}

export function settlementMessages(
  booking: Booking,
  lines: { userId: number; amountCents: number; lateCancellation: boolean }[],
  dict: Dict,
  settings: Settings,
): OutgoingMessage[] {
  const payer = findUserById(booking.payer_id);
  const deadline = DateTime.fromISO(booking.starts_at, { zone: 'utc' })
    .plus({ days: settings.paymentDeadlineDays })
    .toISO()!;

  const out = [`*${dict.settlement.header(booking.code)}*`, ''];
  out.push(`${placeLabel(booking)} · ${formatDateTime(booking.starts_at, settings.timezone, settings.language)}`);
  out.push(`${dict.label.cost}: ${formatMoney(booking.total_cost_cents, booking.currency)}`);
  out.push('');

  for (const line of lines) {
    const name = displayName(findUserById(line.userId));
    const label = line.lateCancellation ? dict.settlement.lateCancelNote(name) : name;
    const suffix = line.userId === booking.payer_id ? ` (${dict.label.paidBy.toLowerCase()})` : '';
    out.push(`  • ${label}: ${formatMoney(line.amountCents, booking.currency)}${suffix}`);
  }

  out.push('');
  out.push(
    dict.settlement.payTo(
      displayName(payer),
      formatDateTime(deadline, settings.timezone, settings.language),
    ),
  );
  if (payer?.payment_handle) out.push(dict.settlement.payHandle(payer.payment_handle));

  return [
    toGroup(
      out.join('\n'),
      lines.map((l) => l.userId).filter((id) => id !== booking.payer_id),
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* report / privacy                                                    */
/* ------------------------------------------------------------------ */

function handleReport(cmd: ParsedCommand, ctx: CommandContext): OutgoingMessage[] {
  const body = cmd.rest.trim();
  if (!body) return [reply(ctx.dict.misc.reportEmpty)];

  const kind = /\b(bug|error|broken|fehler|erro)\b/i.test(body) ? 'BUG' : 'IDEA';
  const { lastInsertRowid } = run(
    'INSERT INTO reports (group_id, user_id, kind, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ctx.groupId,
    ctx.user.id,
    kind,
    body,
    'OPEN',
    nowIso(),
  );

  return [reply(ctx.dict.misc.reportThanks(lastInsertRowid))];
}

function handleForgetMe(ctx: CommandContext): OutgoingMessage[] {
  const open = balanceFor(ctx.user.id, ctx.groupId);
  const owing = open.filter((b) => b.cents > 0).reduce((sum, b) => sum + b.cents, 0);

  // Erasure must not be a way to walk away from a debt someone else is owed.
  if (owing > 0) {
    return [toDm(ctx.user.id, ctx.dict.misc.forgetBlocked(formatMoney(owing, ctx.settings.currency)))];
  }

  setPending(ctx.user.id, ctx.chatId, 'FORGET_ME', {});
  return [reply(`${ctx.dict.misc.forgetConfirm}\n\n${ctx.dict.common.confirmYesNo(ctx.settings.commandPrefix)}`)];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function privateReply(ctx: CommandContext, text: string): OutgoingMessage {
  return ctx.isGroup ? toDm(ctx.user.id, text) : reply(text);
}

function toPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolves a typed name to users. Accepts the disambiguating tail that
 * `displayName` adds when two people share a name, so "Daniel G (…0003)" can be
 * copied straight out of a message the bot just sent.
 *
 * The tail is only read when it is bracketed or ellipsis-prefixed. A bare run of
 * digits is left alone: `!confirm Daniel 10` means ten euros, not a phone
 * fragment, and a name like "Daniel 2" must not be mistaken for one either.
 */
function matchUsersByName(query: string, excludeUserId: number, groupId: number): User[] {
  const raw = query.trim().toLowerCase();
  if (!raw) return [];

  const tail = raw.match(/(?:…|\()\s*#?(\d{2,})\s*\)?/);
  const digits = tail?.[1] ?? null;
  const namePart = (tail ? raw.replace(tail[0], ' ') : raw).replace(/[()…#]/g, '').trim();

  // Restricted to this group's members: naming someone from another group would
  // leak who else uses the bot, and could never resolve to a real debt anyway.
  const memberIds = new Set(listMembers(groupId).map((m) => m.user_id));
  const candidates = listUsers().filter(
    (u) =>
      u.id !== excludeUserId &&
      !u.anonymised_at &&
      memberIds.has(u.id) &&
      (namePart === '' || (u.display_name ?? '').toLowerCase().includes(namePart)),
  );

  if (!digits) return candidates;

  const narrowed = candidates.filter(
    (u) => (u.phone ?? '').endsWith(digits) || String(u.id) === digits,
  );
  // Fall back to the name match if the tail matched nobody, rather than
  // reporting "no such user" for a name that plainly exists.
  return narrowed.length > 0 ? narrowed : candidates;
}

function resolveBookingPlace(
  input: string,
  ctx: CommandContext,
): { placeId: number | null; customPlace: string | null } | { error: string } {
  const { dict, settings } = ctx;
  const known = listPlaces(ctx.groupId);
  const resolved = resolvePlace(input, ctx.groupId);

  if (resolved.place) return { placeId: resolved.place.id, customPlace: null };
  if (resolved.ambiguous) {
    return { error: dict.booking.ambiguousPlace(resolved.ambiguous.map((p) => p.name).join(', ')) };
  }

  if (!settings.allowCustomPlaces) {
    const names = known.map((p) => p.name).join(', ') || '—';
    return { error: dict.booking.unknownPlace(input, names) };
  }

  return { placeId: null, customPlace: input };
}

function bookingErrorText(
  reason: string,
  ctx: CommandContext,
  result: { conflict?: Booking } | Record<string, unknown>,
): string {
  const { dict, settings } = ctx;
  switch (reason) {
    case 'overlap': {
      const conflict = (result as { conflict?: Booking }).conflict;
      if (!conflict) return dict.common.genericError;
      return dict.booking.overlap(
        conflict.code,
        formatDateTime(conflict.starts_at, settings.timezone, settings.language),
      );
    }
    case 'in_past':
      return dict.booking.inPast;
    case 'invalid_players':
      return dict.booking.invalidPlayers;
    case 'custom_place_not_allowed':
      return dict.booking.customPlaceNotAllowed(listPlaces(ctx.groupId).map((p) => p.name).join(', ') || '—');
    case 'no_place':
      return dict.booking.noPlace;
    case 'cancel_limit_locked':
      return dict.booking.cancelLimitLocked;
    default:
      return dict.common.genericError;
  }
}
