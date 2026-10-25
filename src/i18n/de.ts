import type { Dict } from './en.js';

export const de: Dict = {
  label: {
    id: 'ID',
    when: 'Wann',
    place: 'Ort',
    court: 'Platz',
    cost: 'Kosten',
    perPlayer: 'Pro Person',
    players: 'Spieler',
    waitlist: 'Warteliste',
    notes: 'Notizen',
    organiser: 'Organisator',
    paidBy: 'Bezahlt von',
    freeCancelUntil: 'Kostenlos absagen bis',
    addToCalendar: 'Zum Kalender hinzufügen',
    spotsLeft: 'Plätze frei',
    full: 'VOLL',
    nobodyYet: 'noch niemand',
    link: 'Link',
    managedOn: 'Verwaltet über',
    group: 'Gruppe',
    sport: 'Sport',
  },

  external: {
    cancelled: (code: string, provider: string) =>
      `❌ Das ${provider}-Match *${code}* wurde auf ${provider} abgesagt — ich nehme es von der Liste.`,
    created: (code: string, provider: string) => `${provider}-Buchung *${code}* hinzugefügt.`,
    managedNote: (provider: string) =>
      `Anmeldung, Zahlung und Absage laufen direkt über ${provider} — nutze den Link oben.`,
    rosterNotTracked: (code: string, provider: string) =>
      `*${code}* ist eine ${provider}-Buchung — die Spielerliste führe ich dafür nicht. ` +
      `Nutze den ${provider}-Link zum Mitspielen oder Absagen.`,
    noBalance: (provider: string) =>
      `Diese Buchung wird über ${provider} bezahlt und taucht deshalb hier nie in deinem Saldo auf.`,
    badUrl: 'Das sieht nicht nach einem gültigen Link aus. Er sollte mit https:// beginnen.',
    missingUrl: 'Ich brauche den Link zur Reservierung.',
  },

  common: {
    notConfigured:
      'Der Bot ist noch nicht eingerichtet. Ein Admin muss die Einrichtung zuerst in der Weboberfläche abschließen.',
    adminOnly: 'Das darf nur ein Admin.',
    genericError: 'Bei mir ist etwas schiefgelaufen. Die Admins wurden informiert.',
    unknownCommand: (cmd: string, prefix: string) =>
      `Den Befehl "${cmd}" kenne ich nicht. Schick ${prefix}help, um zu sehen, was ich kann.`,
    usage: (usage: string) => `Verwendung: ${usage}`,
    noSuchUser: 'Diese Person kenne ich noch nicht. Sie muss zuerst einmal in die Gruppe schreiben.',
    ambiguousUser: (names: string[]) =>
      `Mehrere Personen passen darauf: ${names.join(', ')}.\n` +
      'Markiere die Person stattdessen mit @, oder schreib den Namen genau wie oben.',
    confirmYesNo: (prefix: string) =>
      `Antworte mit ${prefix}yes zum Bestätigen oder ${prefix}no zum Abbrechen. Wenn du nichts tust, ändert sich nichts.`,
    cancelled: 'Abgebrochen — es wurde nichts geändert.',
    nothingPending: 'Es wartet nichts auf deine Bestätigung.',
    sentPrivately: 'Ich habe dir die Details privat geschickt.',
    whichGroup: (names: string) =>
      `Du bist in mehreren Gruppen, die ich betreue — ich weiß nicht, welche du meinst:\n  • ${names}\n` +
      'Schreib den Gruppennamen dazu, oder schick den Befehl einfach in der Gruppe selbst.',
    cannotDmYou:
      'Ich konnte dir nicht privat schreiben. Schick mir einmal eine Direktnachricht, damit ich dort antworten darf.',
  },

  booking: {
    created: (code: string) => `Buchung *${code}* erstellt.`,
    notFound: (code: string) => `Ich habe keine Buchung mit der ID *${code}*.`,
    cancelled: (code: string, by: string) => `Buchung *${code}* wurde von ${by} storniert.`,
    cancelNotAllowed: 'Nur wer eine Buchung erstellt hat (oder ein Admin) kann sie löschen.',
    alreadyCancelled: 'Diese Buchung ist bereits storniert.',
    alreadySettled: 'Diese Buchung ist bereits abgerechnet und kann nicht mehr geändert werden.',
    inPast: 'Dieses Datum liegt bereits in der Vergangenheit.',
    overlap: (code: string, when: string) =>
      `Das überschneidet sich mit Buchung *${code}* (${when}). Zwei Spiele können nicht gleichzeitig laufen.`,
    invalidPlayers: 'Die maximale Spielerzahl muss mindestens so groß sein wie die minimale.',
    noPlace: 'Ich brauche einen Ort für diese Buchung.',
    customPlaceNotAllowed: (places: string) =>
      `Freie Ortsangaben sind deaktiviert. Bitte wähle einen davon: ${places}`,
    cancelLimitLocked:
      'Der Admin hat die Frist für kurzfristige Absagen fixiert, sie kann pro Buchung nicht geändert werden.',
    unknownPlace: (input: string, places: string) =>
      `Den Ort "${input}" kenne ich nicht. Bekannte Orte: ${places}`,
    ambiguousPlace: (matches: string) => `Welchen meinst du? ${matches}`,
    rescheduled: (code: string, from: string, to: string) =>
      `Buchung *${code}* wurde verschoben.\n` +
      `Vorher: ${from}\nJetzt: ${to}\n\n` +
      'Alle Angemeldeten behalten ihren Platz. Wenn die neue Zeit nicht passt, sag bitte ab.',
    listEmpty: (prefix: string) =>
      `Es stehen keine Buchungen an. Erstelle eine mit ${prefix}book.`,
    listHeader: 'Kommende Spiele',
    listAllHeader: 'Alle deine kommenden Spiele',
    listAllEmpty: (prefix: string) =>
      `In keiner deiner Gruppen stehen Spiele an. Erstelle eins mit ${prefix}book.`,
    listAllSentToDm:
      'Ich habe dir die Liste aller kommenden Spiele aus allen Gruppen privat geschickt, um die Gruppe nicht vollzuspammen.',
    missingFields: (fields: string) => `Mir fehlt noch: ${fields}`,
    badDate: 'Dieses Datum konnte ich nicht lesen. Versuch z. B. 03.09, morgen oder freitag.',
    badTime: 'Diese Uhrzeit konnte ich nicht lesen. Versuch z. B. 19:00.',
    badCost: 'Diesen Betrag konnte ich nicht lesen. Schick nur die Zahl, z. B. 40 oder 40,50.',
    editUsage: (prefix: string) =>
      `Buchung ändern:\n  ${prefix}edit <ID>\n  date: 05/09\n  time: 20:00\n` +
      '(nur die angegebenen Felder ändern sich — nur Ersteller oder Admin)',
    updated: (code: string) => `Buchung *${code}* aktualisiert.`,
  },

  roster: {
    joined: (name: string, code: string, count: number, max: number) =>
      `${name} ist dabei bei *${code}* (${count}/${max}).`,
    joinedFull: (name: string, code: string) => `${name} hat den letzten Platz bei *${code}* genommen.`,
    waitlisted: (name: string, code: string, position: number) =>
      `${name} steht auf der Warteliste für *${code}* (Platz ${position}).`,
    alreadyIn: (code: string) => `Du bist bereits dabei bei *${code}*.`,
    alreadyWaiting: (code: string, position: number) =>
      `Du stehst bereits auf der Warteliste für *${code}* (Platz ${position}).`,
    notIn: (code: string) => `Du bist bei *${code}* nicht dabei.`,
    left: (name: string, code: string, count: number, max: number) =>
      `${name} ist raus bei *${code}* (${count}/${max}).`,
    leftWaitlist: (name: string, code: string) => `${name} hat die Warteliste für *${code}* verlassen.`,
    promoted: (name: string, code: string) =>
      `${name} rückt von der Warteliste in *${code}* nach — du spielst!`,
    bookingPast: 'Dieses Spiel hat bereits begonnen.',

    lateLeaveWarning: (code: string, share: string, deadline: string) =>
      `⚠️ Die Frist für eine kostenlose Absage bei *${code}* ist am ${deadline} abgelaufen.\n\n` +
      `Wenn niemand deinen Platz übernimmt — oder die Gruppe unter die Mindestspielerzahl fällt — ` +
      `schuldest du trotzdem deinen Anteil von etwa ${share}.`,
    lateLeaveConfirmed: (name: string, code: string) =>
      `${name} hat *${code}* nach Ablauf der Absagefrist verlassen und schuldet weiterhin den Anteil, ` +
      `sofern niemand den Platz übernimmt.`,
    lateLeaveReplaced: (name: string, code: string, replacement: string) =>
      `${name} hat *${code}* kurzfristig verlassen, aber ${replacement} hat den Platz übernommen — nichts zu zahlen.`,
    spotOpen: (code: string, count: number, max: number, prefix: string) =>
      `Bei *${code}* ist ein Platz frei geworden (${count}/${max}). Schick ${prefix}join ${code}, um ihn zu nehmen.`,
  },

  payment: {
    balanceAllClear: 'Alles ausgeglichen — in beide Richtungen offen: nichts. 🎉',
    handleSet: (handle: string) => `Zahlungsdaten gespeichert: ${handle}. Andere sehen sie, wenn sie dir Geld schulden.`,
    handleCleared: 'Zahlungsdaten gelöscht.',
    handleCurrent: (handle: string, prefix: string) =>
      `Deine Zahlungsdaten: ${handle}.\nÄndern mit ${prefix}payment <neu>, löschen mit ${prefix}payment clear.`,
    handleNone: (prefix: string) =>
      `Du hast keine Zahlungsdaten hinterlegt. Füge welche hinzu: ${prefix}payment paypal.me/du oder ${prefix}payment <IBAN>.`,
    balanceHeader: 'Dein Kontostand',
    youOwe: (name: string, amount: string) => `Du schuldest ${name}: ${amount}`,
    owesYou: (name: string, amount: string) => `${name} schuldet dir: ${amount}`,
    totalOwed: (amount: string) => `Insgesamt schuldest du: ${amount}`,
    totalOwedToYou: (amount: string) => `Insgesamt schuldet man dir: ${amount}`,
    overallHeader: 'Gruppen-Kontostand',
    suggestedTransfers: 'Einfachster Weg, alles auszugleichen',
    transfer: (from: string, to: string, amount: string) => `${from} → ${to}: ${amount}`,
    perPlayerEstimate: (amount: string, players: number) =>
      `~${amount} pro Person bei ${players} Spielern`,

    recorded: (from: string, to: string, amount: string) =>
      `Zahlung erfasst: ${from} → ${to}, ${amount}.`,
    remaining: (amount: string) => `Noch offen: ${amount}`,
    settledUp: 'Damit ist alles ausgeglichen. 🎉',
    pending: (code: string, to: string, amount: string) =>
      `${amount} an ${to} erfasst. Warte auf die Bestätigung (Vorgang *${code}*).`,
    approvalRequest: (code: string, from: string, amount: string, prefix: string) =>
      `${from} gibt an, dir ${amount} gezahlt zu haben.\n` +
      `Schick ${prefix}approve ${code}, wenn das stimmt, sonst ${prefix}reject ${code}.`,
    approvalRequestToSender: (code: string, to: string, amount: string, prefix: string) =>
      `${to} hat erfasst, dass du ${amount} gezahlt hast.\n` +
      `Schick ${prefix}approve ${code}, wenn das stimmt, sonst ${prefix}reject ${code}.`,
    approved: (code: string, amount: string) => `Zahlung *${code}* (${amount}) bestätigt. Danke!`,
    rejected: (code: string) => `Zahlung *${code}* wurde abgelehnt.`,
    claimNotFound: (code: string) => `Ich habe keine offene Zahlung mit der ID *${code}*.`,
    claimNotAllowed: 'Das darf nur, wer das Geld erhält (oder ein Admin).',
    claimAlreadyResolved: 'Diese Zahlung wurde bereits bearbeitet.',
    nothingOwed: (name: string) => `Du schuldest ${name} im Moment nichts.`,
    proofRequired:
      'Der Admin verlangt einen Zahlungsnachweis. Bitte schick den Screenshot oder Beleg zusammen mit dem Befehl.',
    selfPayment: 'Du kannst dich nicht selbst bezahlen.',
    invalidAmount: 'Dieser Betrag sieht nicht richtig aus.',
    remindDebtor: (creditor: string, amount: string, prefix: string) =>
      `👋 Kleine Erinnerung: Du schuldest ${creditor} ${amount}.\n` +
      `Wenn du bezahlt hast, schick ${prefix}confirm ${creditor}, damit der Saldo ausgeglichen wird.`,
    remindNobodyOwes: 'Dir schuldet gerade niemand etwas. 🎉',
    remindHint: (prefix: string) =>
      `Schick ${prefix}remind, um alle, die dir etwas schulden, privat zu erinnern.`,
    remindSent: (count: number, total: string) =>
      `${count} ${count === 1 ? 'Person' : 'Personen'} erinnert — insgesamt ${total} offen.`,
    remindSkipped: (names: string) => `Kürzlich schon erinnert, deshalb ausgelassen: ${names}`,
    remindAllOnCooldown: (hours: number) =>
      `Alle, die dir etwas schulden, wurden im letzten Tag schon erinnert. Versuch es in etwa ${hours}h nochmal.`,
    deadlineReminder: (amount: string, to: string, days: number) =>
      `Erinnerung: Du schuldest ${to} noch ${amount}. Die Zahlungsfrist der Gruppe ist in ${days} Tag(en).`,
  },

  settlement: {
    header: (code: string) => `💰 Spiel *${code}* ist gespielt — hier die Aufteilung`,
    perPlayer: (amount: string) => `Pro Person: ${amount}`,
    lateCancelNote: (name: string) => `${name} (kurzfristige Absage)`,
    payTo: (name: string, deadline: string) =>
      `Bitte überweise deinen Anteil bis ${deadline} an ${name}.`,
    payHandle: (handle: string) => `Zahlungsdaten: ${handle}`,
  },

  places: {
    header: 'Orte',
    empty: (prefix: string) => `Noch keine Orte. Ein Admin kann einen mit ${prefix}place add <Name> anlegen.`,
    added: (name: string) => `Ort hinzugefügt: ${name}.`,
    removed: (name: string) => `Ort entfernt: ${name}.`,
    deactivated: (name: string) =>
      `Ort ausgeblendet: ${name}. Er bleibt bei alten Buchungen, wird aber nicht mehr angeboten.`,
    exists: (name: string) => `Es gibt bereits einen Ort namens ${name}.`,
    notFound: (name: string) => `Ich habe keinen Ort namens "${name}".`,
    usage: (prefix: string) =>
      `Orte verwalten:\n  ${prefix}place add <Name> | <Adresse>\n  ${prefix}place remove <Name>\n  ${prefix}place list`,
  },

  use: {
    onlyInDm: 'Nutze das im Privatchat mit mir — in einer Gruppe weiß ich schon, welche.',
    onlyOneGroup: 'Du bist nur in einer Gruppe, es gibt nichts zu wechseln.',
    set: (name: string) => `Aktiv auf *${name}*. Deine nächsten Befehle hier gelten dafür, bis du wechselst.`,
    current: (name: string, prefix: string) =>
      `Du bist auf *${name}* aktiv. Wechseln mit ${prefix}use <Gruppe>, löschen mit ${prefix}use none.`,
    none: (prefix: string, groups: string) =>
      `Keine Gruppe gewählt. Wähle mit ${prefix}use <Gruppe>.\nDeine:\n${groups}`,
    cleared: 'Gelöscht — ich frage wieder nach oder richte mich nach dem Namen in deiner Nachricht.',
    notFound: (input: string, groups: string) =>
      `Ich sehe keine Gruppe "${input}", in der du bist. Deine:\n${groups}`,
  },

  misc: {
    reportThanks: (id: number) => `Danke — als Meldung #${id} erfasst. Die Admins sehen sie.`,
    reportEmpty: 'Bitte beschreibe das Problem oder die Idee nach dem Befehl.',
    reminderUnfilled: (code: string, count: number, min: number, prefix: string) =>
      `*${code}* ist morgen und es sind erst ${count}/${min} Spieler dabei. ` +
      `Schick ${prefix}join ${code}, wenn du kannst.`,
    privacyNotice: (prefix: string) =>
      'Ich speichere nur, was ich für die Buchungen brauche: deine WhatsApp-Nummer, deinen Anzeigenamen, ' +
      'die Spiele, bei denen du mitmachst, und offene Beträge. Deinen Nachrichtenverlauf speichere ich nie. ' +
      `Mit ${prefix}forgetme löschst du deine personenbezogenen Daten.`,
    forgetConfirm:
      'Damit werden dein Name und deine Nummer aus dem Bot entfernt. Vergangene Buchungen bleiben anonymisiert erhalten, ' +
      'und ein offener Saldo bleibt für die Person sichtbar, der du etwas schuldest. Das lässt sich nicht rückgängig machen.',
    forgotten: 'Deine personenbezogenen Daten wurden gelöscht.',
    forgetBlocked: (amount: string) =>
      `Du hast noch einen offenen Saldo von ${amount}. Bitte gleich ihn zuerst aus und frag dann erneut.`,
  },
};
