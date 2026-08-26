// Domain ownership map, ported from aventic-gx PR #286 spec/db/domains.ts.
// A product decision, not a derived one. First match wins; order matters.
export const DOMAINS = [
  ["identity", (n) =>
    ["organizations", "organization_members", "organization_venue_access", "user_roles",
     "profiles", "team_invitations", "app_config", "feature_flags", "admin_capabilities",
     "admin_capability_grants", "aventic_operator_tokens", "account_deletion_requests",
    ].includes(n)],
  ["security", (n) =>
    n.endsWith("_audit_log") ||
    /^(access_review|security_alert|privacy_override|restore_test|oauth_state|rejected_login|venue_privacy)/.test(n)],
  ["venues", (n) => n === "venues" || n.startsWith("venue")],
  ["events", (n) => n === "events" || n.startsWith("event")],
  ["kbyg", (n) => n.startsWith("kbyg")],
  ["hub", (n) => n.startsWith("hub")],
  ["team", (n) => n.startsWith("team") || ["tasks", "notification_log"].includes(n)],
  ["premium", (n) => n.startsWith("premium")],
  ["integrations", (n) =>
    /^(integration|org_integration|crm|salesforce|tm_|aventic_sync|enrichment|audience_sync|commerce|youtube|ga4|guest_)/.test(n)],
  ["messaging", (n) => /^(sms|org_phone|edge_rate|device_tokens)/.test(n)],
  ["platform", () => true],
];

export const domainOf = (name) => DOMAINS.find(([, m]) => m(name))[0];
export const DOMAIN_NAMES = DOMAINS.map(([d]) => d);

// Function/enum ownership: same name-based map (hand-curation later is a
// zero-drift move). Enums additionally fall back to the domain of the tables
// that use them.
export function enumOwner(enumName, tables) {
  const users = Object.entries(tables).filter(([, t]) =>
    t.columns.some((c) => c.type === enumName || c.type === `${enumName}[]`));
  if (users.length) {
    const tally = {};
    for (const [name] of users) tally[domainOf(name)] = (tally[domainOf(name)] ?? 0) + 1;
    return Object.entries(tally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  }
  return domainOf(enumName);
}

// storage.objects policies: bucket → owning domain. Mechanical first guess;
// moving a policy between domains later is a zero-drift edit.
export function storageBucketDomain(bucket) {
  if (!bucket) return "platform";
  if (/avatar/.test(bucket)) return "identity";
  if (/team/.test(bucket)) return "team";
  if (/premium/.test(bucket)) return "premium";
  if (/vi[-_]|venue/.test(bucket)) return "venues";
  if (/kbyg|quickstart|workbook|segment/.test(bucket)) return "kbyg";
  if (/feedback/.test(bucket)) return "platform";
  return "platform";
}

export function realtimeTopicDomain(name, qual) {
  const text = `${name} ${qual ?? ""}`;
  if (/team[- ]typing|team-/.test(text)) return "team";
  if (/kbyg/.test(text)) return "kbyg";
  if (/presence|org member/.test(text)) return "identity";
  return "platform";
}

export function cronOwner(jobname) {
  if (jobname.startsWith("kbyg")) return "kbyg";
  if (/^ga4|salesforce|integration/.test(jobname)) return "integrations";
  return "platform";
}
