// The Telegram wording of an alarm from this stack. Split out of index.js when
// the topic stopped carrying heartbeat alarms alone: the message used to state
// « Le heartbeat s'est tu » for ANY alarm reaching the relay, so a throttled
// registry would have been announced as a dead instance — a wrong first sentence
// at the one moment somebody is reading fast.
//
// Keyed by the SUFFIX of the alarm name, because the prefix is the stack name
// and changes per deployment. An unknown alarm still gets announced, with its
// own CloudWatch reason as the body — a new alarm must never be silent just
// because nobody wrote a sentence for it here.
const EXPLANATIONS = [
  [
    "-heartbeat",
    "Le heartbeat s'est tu (instance morte, service bloqué, réplication down ou réseau coupé). " +
      "L'ASG remplace l'instance si nécessaire — reprise attendue en ~2 min.",
  ],
  [
    "-no-instance",
    "Le groupe d'auto-scaling n'a plus aucune instance en service : plus aucune base client n'est joignable.",
  ],
  [
    "-registry-system-errors",
    "Le registre DynamoDB — la table qui dit où vit CHAQUE base client — renvoie des erreurs système. " +
      "Ça ne casse pas une app, ça casse la résolution de toutes.",
  ],
  [
    "-registry-throttles",
    "Le registre DynamoDB est throttlé. Invisible autrement : ce n'est ni une erreur Lambda ni un 5xx de passerelle.",
  ],
];

function explain(name) {
  const hit = EXPLANATIONS.find(([suffix]) => typeof name === "string" && name.endsWith(suffix));
  return hit ? hit[1] : "";
}

function formatMessage(alarm) {
  const name = (alarm && alarm.AlarmName) || "alarme inconnue";
  const state = alarm && alarm.NewStateValue;
  const reason = (alarm && alarm.NewStateReason) || "";
  if (state === "ALARM") {
    const body = [explain(name), reason].filter(Boolean).join("\n\n");
    return `🔴 Dilaya SQLite Data API — « ${name} » est en ALARME.\n${body}`;
  }
  if (state === "OK") {
    return `🟢 Dilaya SQLite Data API — « ${name} » est rétablie.`;
  }
  return `⚪️ Dilaya SQLite Data API — « ${name} » : ${state}.\n${reason}`;
}

module.exports = { formatMessage, explain };
