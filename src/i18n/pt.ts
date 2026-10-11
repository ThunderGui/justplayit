import type { Dict } from './en.js';

export const pt: Dict = {
  label: {
    id: 'ID',
    when: 'Quando',
    place: 'Local',
    court: 'Campo',
    cost: 'Custo',
    perPlayer: 'Por jogador',
    players: 'Jogadores',
    waitlist: 'Lista de espera',
    notes: 'Notas',
    organiser: 'Organizador',
    paidBy: 'Pago por',
    freeCancelUntil: 'Cancelamento grátis até',
    addToCalendar: 'Adicionar ao calendário',
    spotsLeft: 'vagas livres',
    full: 'COMPLETO',
    nobodyYet: 'ainda ninguém',
    link: 'Link',
    managedOn: 'Gerido em',
  },

  external: {
    created: (code: string, provider: string) => `Reserva ${provider} *${code}* adicionada.`,
    managedNote: (provider: string) =>
      `A inscrição, o pagamento e o cancelamento são feitos diretamente no ${provider}, pelo link acima.`,
    rosterNotTracked: (code: string, provider: string) =>
      `*${code}* é uma reserva ${provider} — não faço a gestão da lista de jogadores. ` +
      `Usa o link do ${provider} para entrar ou cancelar.`,
    noBalance: (provider: string) =>
      `Essa reserva é paga através do ${provider}, por isso nunca aparece no teu saldo aqui.`,
    badUrl: 'Isso não parece um link válido. Deve começar por https://',
    missingUrl: 'Preciso do link da reserva.',
  },

  common: {
    notConfigured:
      'O bot ainda não foi configurado. Um administrador tem de concluir a configuração na página web primeiro.',
    adminOnly: 'Só um administrador pode fazer isso.',
    genericError: 'Algo correu mal do meu lado. Os administradores foram notificados.',
    unknownCommand: (cmd: string, prefix: string) =>
      `Não conheço o comando "${cmd}". Envia ${prefix}help para veres o que sei fazer.`,
    usage: (usage: string) => `Utilização: ${usage}`,
    noSuchUser: 'Ainda não conheço essa pessoa. Ela tem de escrever no grupo primeiro.',
    ambiguousUser: (names: string[]) =>
      `Há várias pessoas com esse nome: ${names.join(', ')}.\n` +
      'Marca a pessoa com @, ou escreve o nome exatamente como está acima.',
    confirmYesNo: (prefix: string) =>
      `Responde ${prefix}yes para confirmar, ou ${prefix}no para cancelar. Se não fizeres nada, nada muda.`,
    cancelled: 'Cancelado — nada foi alterado.',
    nothingPending: 'Não tens nada à espera de confirmação.',
    sentPrivately: 'Enviei-te os detalhes em privado.',
    whichGroup: (names: string) =>
      `Estás em mais do que um grupo que eu gerí­o, por isso não sei qual queres:\n  • ${names}\n` +
      'Acrescenta o nome do grupo ao comando, ou envia-o no próprio grupo.',
    cannotDmYou:
      'Não consegui enviar-te mensagem privada. Envia-me uma mensagem direta uma vez para eu poder responder aí.',
  },

  booking: {
    created: (code: string) => `Reserva *${code}* criada.`,
    notFound: (code: string) => `Não tenho nenhuma reserva com o ID *${code}*.`,
    cancelled: (code: string, by: string) => `A reserva *${code}* foi cancelada por ${by}.`,
    cancelNotAllowed: 'Só quem criou a reserva (ou um administrador) a pode apagar.',
    alreadyCancelled: 'Essa reserva já está cancelada.',
    alreadySettled: 'Essa reserva já foi acertada e não pode ser alterada.',
    inPast: 'Essa data e hora já passaram.',
    overlap: (code: string, when: string) =>
      `Isso choca com a reserva *${code}* (${when}). Não podem existir dois jogos à mesma hora.`,
    invalidPlayers: 'O número máximo de jogadores tem de ser pelo menos igual ao mínimo.',
    noPlace: 'Preciso de um local para esta reserva.',
    customPlaceNotAllowed: (places: string) =>
      `Locais livres estão desativados. Escolhe um destes: ${places}`,
    cancelLimitLocked:
      'O administrador fixou o limite de cancelamento tardio, por isso não pode ser alterado por reserva.',
    unknownPlace: (input: string, places: string) =>
      `Não conheço o local "${input}". Locais conhecidos: ${places}`,
    ambiguousPlace: (matches: string) => `Qual deles queres dizer? ${matches}`,
    rescheduled: (code: string, from: string, to: string) =>
      `📅 A reserva *${code}* foi alterada.\n` +
      `Antes: ${from}\nAgora: ${to}\n\n` +
      'Quem já está inscrito mantém a vaga. Se o novo horário não te servir, sai da reserva.',
    listEmpty: (prefix: string) =>
      `Não há reservas marcadas. Cria uma com ${prefix}book.`,
    listHeader: 'Próximos jogos',
    missingFields: (fields: string) => `Ainda me falta: ${fields}`,
    badDate: 'Não consegui ler essa data. Tenta algo como 03/09, amanhã ou sexta.',
    badTime: 'Não consegui ler essa hora. Tenta algo como 19:00.',
    badCost: 'Não consegui ler esse valor. Envia só o número, por exemplo 40 ou 40,50.',
    editUsage: (prefix: string) =>
      `Alterar uma reserva:\n  ${prefix}edit <id>\n  date: 05/09\n  time: 20:00\n` +
      '(só mudam os campos que incluíres — apenas criador ou admin)',
    updated: (code: string) => `Reserva *${code}* atualizada.`,
  },

  roster: {
    joined: (name: string, code: string, count: number, max: number) =>
      `${name} entrou em *${code}* (${count}/${max}).`,
    joinedFull: (name: string, code: string) => `${name} ficou com a última vaga de *${code}*.`,
    waitlisted: (name: string, code: string, position: number) =>
      `${name} está na lista de espera de *${code}* (posição ${position}).`,
    alreadyIn: (code: string) => `Já estás inscrito em *${code}*.`,
    alreadyWaiting: (code: string, position: number) =>
      `Já estás na lista de espera de *${code}* (posição ${position}).`,
    notIn: (code: string) => `Não estás inscrito em *${code}*.`,
    left: (name: string, code: string, count: number, max: number) =>
      `${name} saiu de *${code}* (${count}/${max}).`,
    leftWaitlist: (name: string, code: string) => `${name} saiu da lista de espera de *${code}*.`,
    promoted: (name: string, code: string) =>
      `${name} sobe da lista de espera para *${code}* — vais jogar!`,
    bookingPast: 'Esse jogo já começou.',

    lateLeaveWarning: (code: string, share: string, deadline: string) =>
      `⚠️ O prazo de cancelamento grátis de *${code}* terminou a ${deadline}.\n\n` +
      `Se ninguém ficar com a tua vaga — ou se o grupo ficar abaixo do mínimo de jogadores — ` +
      `continuas a dever a tua parte, cerca de ${share}.`,
    lateLeaveConfirmed: (name: string, code: string) =>
      `${name} saiu de *${code}* depois do prazo de cancelamento e continua a dever a sua parte, ` +
      `a não ser que alguém fique com a vaga.`,
    lateLeaveReplaced: (name: string, code: string, replacement: string) =>
      `${name} saiu tarde de *${code}*, mas ${replacement} ficou com a vaga — não deve nada.`,
    spotOpen: (code: string, count: number, max: number, prefix: string) =>
      `Abriu uma vaga em *${code}* (${count}/${max}). Envia ${prefix}join ${code} para a ocupares.`,
  },

  payment: {
    balanceAllClear: 'Estás em dia — nada a dever nem a receber. 🎉',
    handleSet: (handle: string) => `Dados de pagamento guardados: ${handle}. As pessoas veem-nos quando te devem dinheiro.`,
    handleCleared: 'Dados de pagamento removidos.',
    handleCurrent: (handle: string, prefix: string) =>
      `Os teus dados de pagamento: ${handle}.\nAltera com ${prefix}payment <novo>, ou ${prefix}payment clear para remover.`,
    handleNone: (prefix: string) =>
      `Não tens dados de pagamento. Adiciona com ${prefix}payment paypal.me/tu ou ${prefix}payment <IBAN>.`,
    balanceHeader: 'O teu saldo',
    youOwe: (name: string, amount: string) => `Deves a ${name}: ${amount}`,
    owesYou: (name: string, amount: string) => `${name} deve-te: ${amount}`,
    totalOwed: (amount: string) => `Total que deves: ${amount}`,
    totalOwedToYou: (amount: string) => `Total que te devem: ${amount}`,
    overallHeader: 'Saldo do grupo',
    suggestedTransfers: 'Forma mais simples de acertar tudo',
    transfer: (from: string, to: string, amount: string) => `${from} → ${to}: ${amount}`,
    perPlayerEstimate: (amount: string, players: number) =>
      `~${amount} por jogador com ${players} jogadores`,

    recorded: (from: string, to: string, amount: string) =>
      `Pagamento registado: ${from} → ${to}, ${amount}.`,
    remaining: (amount: string) => `Ainda em aberto: ${amount}`,
    settledUp: 'Com isto ficas em dia. 🎉',
    pending: (code: string, to: string, amount: string) =>
      `Registei ${amount} para ${to}. À espera da confirmação (registo *${code}*).`,
    approvalRequest: (code: string, from: string, amount: string, prefix: string) =>
      `${from} diz que te pagou ${amount}.\n` +
      `Envia ${prefix}approve ${code} se estiver certo, ou ${prefix}reject ${code} se não.`,
    approvalRequestToSender: (code: string, to: string, amount: string, prefix: string) =>
      `${to} registou que lhe pagaste ${amount}.\n` +
      `Envia ${prefix}approve ${code} se estiver certo, ou ${prefix}reject ${code} se não.`,
    approved: (code: string, amount: string) => `Pagamento *${code}* (${amount}) confirmado. Obrigado!`,
    rejected: (code: string) => `O pagamento *${code}* foi rejeitado.`,
    claimNotFound: (code: string) => `Não tenho nenhum pagamento pendente com o ID *${code}*.`,
    claimNotAllowed: 'Só quem recebe o dinheiro (ou um administrador) pode fazer isso.',
    claimAlreadyResolved: 'Esse pagamento já foi tratado.',
    nothingOwed: (name: string) => `Neste momento não deves nada a ${name}.`,
    proofRequired:
      'O administrador exige comprovativo de pagamento. Envia a captura de ecrã ou o recibo junto com o comando.',
    selfPayment: 'Não te podes pagar a ti próprio.',
    invalidAmount: 'Esse valor não parece certo.',
    remindDebtor: (creditor: string, amount: string, prefix: string) =>
      `👋 Um lembrete: deves ${amount} a ${creditor}.\n` +
      `Quando pagares, envia ${prefix}confirm ${creditor} para acertar o saldo.`,
    remindNobodyOwes: 'Ninguém te deve nada neste momento. 🎉',
    remindHint: (prefix: string) =>
      `Envia ${prefix}remind para avisares em privado quem te deve.`,
    remindSent: (count: number, total: string) =>
      `${count} ${count === 1 ? 'pessoa avisada' : 'pessoas avisadas'} — ${total} em aberto no total.`,
    remindSkipped: (names: string) => `Já avisados há pouco, por isso ficaram de fora: ${names}`,
    remindAllOnCooldown: (hours: number) =>
      `Toda a gente que te deve já foi avisada no último dia. Tenta outra vez daqui a cerca de ${hours}h.`,
    deadlineReminder: (amount: string, to: string, days: number) =>
      `Lembrete: ainda deves ${amount} a ${to}. O prazo de pagamento do grupo é daqui a ${days} dia(s).`,
  },

  settlement: {
    header: (code: string) => `O jogo *${code}* terminou — aqui está a divisão`,
    perPlayer: (amount: string) => `Por jogador: ${amount}`,
    lateCancelNote: (name: string) => `${name} (cancelamento tardio)`,
    payTo: (name: string, deadline: string) => `Envia a tua parte a ${name} até ${deadline}.`,
    payHandle: (handle: string) => `Dados de pagamento: ${handle}`,
  },

  places: {
    header: 'Locais',
    empty: (prefix: string) => `Ainda não há locais. Um administrador pode adicionar com ${prefix}place add <nome>.`,
    added: (name: string) => `Local adicionado: ${name}.`,
    removed: (name: string) => `Local removido: ${name}.`,
    deactivated: (name: string) =>
      `Local ocultado: ${name}. Fica nas reservas antigas, mas deixa de ser oferecido.`,
    exists: (name: string) => `Já existe um local chamado ${name}.`,
    notFound: (name: string) => `Não tenho nenhum local chamado "${name}".`,
    usage: (prefix: string) =>
      `Gerir locais:\n  ${prefix}place add <nome> | <endereço>\n  ${prefix}place remove <nome>\n  ${prefix}place list`,
  },

  misc: {
    reportThanks: (id: number) => `Obrigado — registado como reporte #${id}. Os administradores vão ver.`,
    reportEmpty: 'Descreve o problema ou a ideia a seguir ao comando.',
    reminderUnfilled: (code: string, count: number, min: number, prefix: string) =>
      `*${code}* é amanhã e só há ${count}/${min} jogadores. ` +
      `Envia ${prefix}join ${code} se puderes ir.`,
    privacyNotice: (prefix: string) =>
      'Guardo apenas o necessário para gerir as reservas: o teu número de WhatsApp, o nome que mostras, ' +
      'os jogos em que entras e os valores em aberto. Nunca guardo o teu histórico de mensagens. ' +
      `Usa ${prefix}forgetme para eliminares os teus dados pessoais.`,
    forgetConfirm:
      'Isto remove o teu nome e número do bot. As reservas passadas ficam como registos anónimos ' +
      'e qualquer saldo em aberto continua visível para quem tem a receber. Não é possível anular.',
    forgotten: 'Os teus dados pessoais foram eliminados.',
    forgetBlocked: (amount: string) =>
      `Ainda tens um saldo em aberto de ${amount}. Acerta-o primeiro e volta a pedir.`,
  },
};
