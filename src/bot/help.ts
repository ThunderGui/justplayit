import type { Settings } from '../domain/settings.js';
import type { Dict } from '../i18n/index.js';

/**
 * The design asks for help that is "very objective": what to type, one line
 * each, with the two rules people actually get caught by at the end.
 */
export function helpText(dict: Dict, settings: Settings, isAdmin: boolean): string {
  const p = settings.commandPrefix;

  const lines = [
    '*Just Play It*',
    '',
    `${p}list — all upcoming games`,
    `${p}show <id> — full details of one game`,
    `${p}join <id> — take a spot (or join the waiting list if full)`,
    `${p}leave <id> — give up your spot`,
    `${p}balance — who owes whom (always answered privately)`,
    `${p}confirm <name> [amount] — record that you paid someone`,
    `${p}remind [name] — privately nudge whoever owes you`,
    `${p}report <text> — report a bug or suggest an improvement`,
    `${p}help — this message`,
    '',
    '*New booking*',
    `${p}book`,
    '  place: Padel Base',
    '  date: 03/09      (or: tomorrow, friday)',
    '  time: 19:00',
    '  cost: 40',
    '  max: 4           (optional)',
    '  min: 4           (optional)',
    '  court: 3         (optional)',
    '  notes: …         (optional)',
    `  cancel: 24       (optional, hours — default ${settings.defaultCancelLimitHours}h)`,
    '',
    '*Booking made on Playtomic*',
    `${p}playtomic`,
    '  url: https://playtomic.io/…',
    '  date: 03/09',
    '  time: 19:00',
    '',
    `${p}cancel <id> — delete a booking (creator or admin only)`,
    '',
    '*Rules*',
    `• Free cancellation up to ${settings.defaultCancelLimitHours}h before the game.`,
    '• Leaving after that still costs your share, unless someone takes your spot',
    '  and the group still reaches the minimum number of players.',
    '• Two games can never be booked for the same time.',
    `• Payment is due within ${settings.paymentDeadlineDays} days of the game.`,
    '• Playtomic bookings are managed entirely on Playtomic — the bot only lists them.',
  ];

  if (isAdmin) {
    lines.push(
      '',
      '*Admin*',
      `${p}settle <id> — close a game and split the cost now`,
      `${p}approve <payment-id> / ${p}reject <payment-id>`,
      `${p}balance — also shows the whole group's balance`,
      'Everything else is configured in the web console.',
    );
  }

  lines.push('', `_${dict.misc.privacyNotice(p)}_`);

  return lines.join('\n');
}
