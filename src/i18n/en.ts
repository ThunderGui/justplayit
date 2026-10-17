export const en = {
  /* ---- labels used to build booking cards ---- */
  label: {
    id: 'ID',
    when: 'When',
    place: 'Place',
    court: 'Court',
    cost: 'Cost',
    perPlayer: 'Per player',
    players: 'Players',
    waitlist: 'Waiting list',
    notes: 'Notes',
    organiser: 'Organiser',
    paidBy: 'Paid by',
    freeCancelUntil: 'Free cancel until',
    addToCalendar: 'Add to calendar',
    spotsLeft: 'spots left',
    full: 'FULL',
    nobodyYet: 'nobody yet',
    link: 'Link',
    managedOn: 'Managed on',
  },

  /* ---- bookings held on an external platform (Playtomic etc.) ---- */
  external: {
    created: (code: string, provider: string) => `${provider} booking *${code}* added.`,
    cancelled: (code: string, provider: string) =>
      `❌ The ${provider} match *${code}* was cancelled on ${provider} — removing it from the list.`,
    /** Shown on the card so nobody waits for the bot to organise this one. */
    managedNote: (provider: string) =>
      `Sign up, pay and cancel directly on ${provider} using the link above.`,
    rosterNotTracked: (code: string, provider: string) =>
      `*${code}* is a ${provider} booking — I do not keep the player list for it. ` +
      `Use the ${provider} link to join or cancel.`,
    noBalance: (provider: string) =>
      `That booking is paid through ${provider}, so it never appears in your balance here.`,
    badUrl: 'That does not look like a valid link. It should start with https://',
    missingUrl: 'I need the link to the reservation.',
  },

  /* ---- generic ---- */
  common: {
    notConfigured:
      'This bot has not been set up yet. An admin needs to finish the setup in the web console first.',
    adminOnly: 'Only an admin can do that.',
    genericError: 'Something went wrong on my side. The admins have been notified.',
    unknownCommand: (cmd: string, prefix: string) =>
      `I do not know the command "${cmd}". Send ${prefix}help to see what I can do.`,
    usage: (usage: string) => `Usage: ${usage}`,
    noSuchUser: 'I do not know that person yet. They need to send a message to this group first.',
    ambiguousUser: (names: string[]) =>
      `Several people match that name: ${names.join(', ')}.\n` +
      'Tag them with @ instead, or repeat the name exactly as written above.',
    confirmYesNo: (prefix: string) =>
      `Reply ${prefix}yes to confirm, or ${prefix}no to cancel. If you do nothing, nothing changes.`,
    cancelled: 'Cancelled — nothing was changed.',
    nothingPending: 'You have nothing waiting for confirmation.',
    sentPrivately: 'I have sent you the details privately.',
    whichGroup: (names: string) =>
      `You are in more than one group I look after, so I do not know which you mean:\n  • ${names}\n` +
      'Add the group name to your command, or just send it in the group itself.',
    cannotDmYou:
      'I could not message you privately. Send me a direct message once so I am allowed to reply there.',
  },

  /* ---- bookings ---- */
  booking: {
    created: (code: string) => `Booking *${code}* created.`,
    notFound: (code: string) => `I have no booking with the ID *${code}*.`,
    cancelled: (code: string, by: string) => `Booking *${code}* was cancelled by ${by}.`,
    cancelNotAllowed: 'Only the person who created a booking (or an admin) can delete it.',
    alreadyCancelled: 'That booking is already cancelled.',
    alreadySettled: 'That booking is already settled and can no longer be changed.',
    inPast: 'That date and time is already in the past.',
    overlap: (code: string, when: string) =>
      `That clashes with booking *${code}* (${when}). Two games cannot run at the same time.`,
    invalidPlayers: 'The maximum number of players must be at least the minimum.',
    noPlace: 'I need a place for this booking.',
    customPlaceNotAllowed: (places: string) =>
      `Free-text locations are turned off. Please pick one of: ${places}`,
    cancelLimitLocked:
      'The admin fixed the late-cancellation limit, so it cannot be changed per booking.',
    unknownPlace: (input: string, places: string) =>
      `I do not know the place "${input}". Known places: ${places}`,
    ambiguousPlace: (matches: string) => `Which one do you mean? ${matches}`,
    rescheduled: (code: string, from: string, to: string) =>
      `Booking *${code}* has been moved.\n` +
      `Was: ${from}\nNow: ${to}\n\n` +
      'Everyone already in keeps their spot. If the new time does not work for you, please leave the booking.',
    listEmpty: (prefix: string) =>
      `There are no bookings coming up. Create one with ${prefix}book.`,
    listHeader: 'Upcoming games',
    missingFields: (fields: string) => `I still need: ${fields}`,
    badDate: 'I could not read that date. Try something like 03/09, tomorrow, or friday.',
    badTime: 'I could not read that time. Try something like 19:00 or 7pm.',
    badCost: 'I could not read that amount. Send just the number, for example 40 or 40.50.',
    editUsage: (prefix: string) =>
      `To change a booking:\n  ${prefix}edit <id>\n  date: 05/09\n  time: 20:00\n` +
      '(only the fields you include change — creator or admin only)',
    updated: (code: string) => `Booking *${code}* updated.`,
  },

  /* ---- join / leave ---- */
  roster: {
    joined: (name: string, code: string, count: number, max: number) =>
      `${name} is in for *${code}* (${count}/${max}).`,
    joinedFull: (name: string, code: string) => `${name} took the last spot for *${code}*.`,
    waitlisted: (name: string, code: string, position: number) =>
      `${name} is on the waiting list for *${code}* (position ${position}).`,
    alreadyIn: (code: string) => `You are already in for *${code}*.`,
    alreadyWaiting: (code: string, position: number) =>
      `You are already on the waiting list for *${code}* (position ${position}).`,
    notIn: (code: string) => `You are not in for *${code}*.`,
    left: (name: string, code: string, count: number, max: number) =>
      `${name} is out of *${code}* (${count}/${max}).`,
    leftWaitlist: (name: string, code: string) => `${name} left the waiting list for *${code}*.`,
    promoted: (name: string, code: string) =>
      `${name} moves up from the waiting list into *${code}* — you are playing!`,
    bookingPast: 'That game has already started.',

    lateLeaveWarning: (code: string, share: string, deadline: string) =>
      `⚠️ The free-cancellation deadline for *${code}* passed on ${deadline}.\n\n` +
      `If nobody takes your spot — or the group ends up below the minimum number of players — ` +
      `you still owe your share of about ${share}.`,
    lateLeaveConfirmed: (name: string, code: string) =>
      `${name} left *${code}* after the cancellation deadline and still owes their share ` +
      `unless someone takes the spot.`,
    lateLeaveReplaced: (name: string, code: string, replacement: string) =>
      `${name} left *${code}* late, but ${replacement} took the spot — nothing owed.`,
    spotOpen: (code: string, count: number, max: number, prefix: string) =>
      `A spot opened up for *${code}* (${count}/${max}). Send ${prefix}join ${code} to take it.`,
  },

  /* ---- payments ---- */
  payment: {
    balanceAllClear: 'You are all square — nothing owed in either direction. 🎉',
    handleSet: (handle: string) => `Saved your payment details: ${handle}. People will see this when you are owed money.`,
    handleCleared: 'Cleared your payment details.',
    handleCurrent: (handle: string, prefix: string) =>
      `Your payment details: ${handle}.\nChange them with ${prefix}payment <new>, or ${prefix}payment clear to remove.`,
    handleNone: (prefix: string) =>
      `You have no payment details set. Add some with ${prefix}payment paypal.me/you or ${prefix}payment <IBAN>.`,
    balanceHeader: 'Your balance',
    youOwe: (name: string, amount: string) => `You owe ${name}: ${amount}`,
    owesYou: (name: string, amount: string) => `${name} owes you: ${amount}`,
    totalOwed: (amount: string) => `Total you owe: ${amount}`,
    totalOwedToYou: (amount: string) => `Total owed to you: ${amount}`,
    overallHeader: 'Group balance',
    suggestedTransfers: 'Simplest way to settle everything',
    transfer: (from: string, to: string, amount: string) => `${from} → ${to}: ${amount}`,
    /** Expected split on a booking card, e.g. "~€10.00 each at 4 players". */
    perPlayerEstimate: (amount: string, players: number) =>
      `~${amount} each at ${players} players`,

    recorded: (from: string, to: string, amount: string) =>
      `Payment recorded: ${from} → ${to}, ${amount}.`,
    remaining: (amount: string) => `Still open: ${amount}`,
    settledUp: 'That settles it — you are square. 🎉',
    pending: (code: string, to: string, amount: string) =>
      `Recorded ${amount} to ${to}. Waiting for them to confirm (claim *${code}*).`,
    approvalRequest: (code: string, from: string, amount: string, prefix: string) =>
      `${from} says they paid you ${amount}.\n` +
      `Send ${prefix}approve ${code} if that is right, or ${prefix}reject ${code} if not.`,
    /** Used when the receiver files the claim and the sender must sign off. */
    approvalRequestToSender: (code: string, to: string, amount: string, prefix: string) =>
      `${to} recorded that you paid them ${amount}.\n` +
      `Send ${prefix}approve ${code} if that is right, or ${prefix}reject ${code} if not.`,
    approved: (code: string, amount: string) => `Payment *${code}* (${amount}) confirmed. Thanks!`,
    rejected: (code: string) => `Payment *${code}* was rejected.`,
    claimNotFound: (code: string) => `I have no pending payment with the ID *${code}*.`,
    claimNotAllowed: 'Only the person receiving the money (or an admin) can do that.',
    claimAlreadyResolved: 'That payment has already been handled.',
    nothingOwed: (name: string) => `You do not owe ${name} anything right now.`,
    proofRequired:
      'The admin requires proof of payment. Please send the screenshot or receipt together with the command.',
    selfPayment: 'You cannot pay yourself.',
    invalidAmount: 'That amount does not look right.',
    /** The private nudge the debtor receives. */
    remindDebtor: (creditor: string, amount: string, prefix: string) =>
      `👋 A friendly reminder: you owe ${creditor} ${amount}.\n` +
      `Once you have paid, send ${prefix}confirm ${creditor} so the balance is cleared.`,
    remindNobodyOwes: 'Nobody owes you anything right now. 🎉',
    /** Shown under a balance that has money coming in, so the command is findable. */
    remindHint: (prefix: string) =>
      `Send ${prefix}remind to privately nudge whoever owes you.`,
    remindSent: (count: number, total: string) =>
      `Reminded ${count} ${count === 1 ? 'person' : 'people'} — ${total} outstanding in total.`,
    remindSkipped: (names: string) => `Already reminded recently, so left alone: ${names}`,
    remindAllOnCooldown: (hours: number) =>
      `Everyone who owes you was reminded in the last day already. Try again in about ${hours}h.`,
    deadlineReminder: (amount: string, to: string, days: number) =>
      `Reminder: you still owe ${to} ${amount}. The group's payment deadline is in ${days} day(s).`,
  },

  /* ---- settlement ---- */
  settlement: {
    header: (code: string) => `💰 Game *${code}* is done — here is the split`,
    perPlayer: (amount: string) => `Each player: ${amount}`,
    lateCancelNote: (name: string) => `${name} (late cancellation)`,
    payTo: (name: string, deadline: string) => `Please send your share to ${name} by ${deadline}.`,
    payHandle: (handle: string) => `Payment details: ${handle}`,
  },

  /* ---- places (admin manage from chat) ---- */
  places: {
    header: 'Places',
    empty: (prefix: string) => `No places yet. An admin can add one with ${prefix}place add <name>.`,
    added: (name: string) => `Added place: ${name}.`,
    removed: (name: string) => `Removed place: ${name}.`,
    deactivated: (name: string) =>
      `Hid place: ${name}. It stays on past bookings but is no longer offered for new ones.`,
    exists: (name: string) => `There is already a place called ${name}.`,
    notFound: (name: string) => `I have no place called "${name}".`,
    usage: (prefix: string) =>
      `To manage places:\n  ${prefix}place add <name> | <address>\n  ${prefix}place remove <name>\n  ${prefix}place list`,
  },

  /* ---- .use (pick a group in a private chat) ---- */
  use: {
    onlyInDm: 'Use this in a private chat with me — in a group I already know which one.',
    onlyOneGroup: 'You are only in one group, so there is nothing to switch between.',
    set: (name: string) => `Now acting on *${name}*. Your next commands here apply to it until you switch.`,
    current: (name: string, prefix: string) =>
      `You are acting on *${name}*. Switch with ${prefix}use <group>, or ${prefix}use none to clear.`,
    none: (prefix: string, groups: string) =>
      `No group chosen. Pick one with ${prefix}use <group>.\nYours:\n${groups}`,
    cleared: 'Cleared — I will ask which group again, or go by the name in your message.',
    notFound: (input: string, groups: string) =>
      `I do not see a group "${input}" that you are in. Yours:\n${groups}`,
  },

  /* ---- misc ---- */
  misc: {
    reportThanks: (id: number) => `Thanks — logged as report #${id}. The admins will see it.`,
    reportEmpty: 'Please describe the problem or idea after the command.',
    reminderUnfilled: (code: string, count: number, min: number, prefix: string) =>
      `*${code}* is tomorrow and only ${count}/${min} players are in. ` +
      `Send ${prefix}join ${code} if you can make it.`,
    privacyNotice: (prefix: string) =>
      'I store only what I need to run the bookings: your WhatsApp number, display name, ' +
      'the games you join and what you owe. I never store your message history. ' +
      `Send ${prefix}forgetme to have your personal data removed.`,
    forgetConfirm:
      'This removes your name and number from the bot. Past bookings stay as anonymous entries, ' +
      'and any open balance stays visible to the person you owe. This cannot be undone.',
    forgotten: 'Your personal data has been removed.',
    forgetBlocked: (amount: string) =>
      `You still have an open balance of ${amount}. Please settle it first, then ask again.`,
  },
};

/**
 * English is the source of truth: every other catalogue is typed against this
 * shape, so a missing or renamed key fails the build rather than falling back
 * silently at runtime.
 */
export type Dict = typeof en;
