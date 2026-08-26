import "./index.js";

using TypeSpec.Reflection;

// Table-fact decorators (grammar rules 6-9, 17)
extern dec rls(target: Model);
extern dec external(target: Model);
extern dec pk(target: Model, cols: valueof string, name?: valueof string);
extern dec partition_by(target: Model, spec: valueof string);
extern dec check(target: Model | ModelProperty, expr: valueof string, name?: valueof string);
extern dec constraint(target: Model, name: valueof string, def: valueof string);
extern dec identity(target: ModelProperty, kind: valueof string);
extern dec references(target: ModelProperty, ref: ModelProperty, actions?: valueof string, name?: valueof string);
extern dec generated(target: ModelProperty, sql: valueof string);
extern dec grant(target: Model | Operation, role: valueof string, privileges: valueof string);
extern dec pg_type(target: ModelProperty, sqlType: valueof string);

// Ledger decorators (used as @@ statements below the model)
extern dec index(target: Model, tail: valueof string);
extern dec policy(target: Model, name: valueof string, tail: valueof string);
extern dec trigger(target: Model, name: valueof string, fires: valueof string, execute: Operation);

// Views
extern dec view(target: Model, body?: valueof string);
extern dec security_invoker(target: Model);
extern dec security_definer(target: Model);

// Functions
extern dec function(target: Operation, options: valueof string, body?: valueof string);
extern dec pg_name(target: Operation, name: valueof string);

// Cron
extern dec schedule(target: Operation, cron: valueof string);
extern dec command(target: Operation, sql: valueof string);

// The value-position SQL marker: one type-agnostic constructor, made
// assignable to every column type by union membership in the aliases
// below. Global scope, not `public` — it is a spec-language marker, not a
// pg type, and value references (`sql.of(...)`) must resolve from every
// namespace. Literals stay literals (String/Numeric/Boolean/Enum values):
// the literal/SQL bright line is the VALUE KIND, not a quoting convention.
scalar sql {
  init of(expr: string);
}

namespace `public` {
  scalar uuid_s extends string;
  alias uuid = uuid_s | sql;
  scalar text_s extends string;
  alias text = text_s | sql;
  scalar timestamptz_s;
  alias timestamptz = timestamptz_s | sql;
  scalar timestamp_s;
  alias timestamp = timestamp_s | sql;
  scalar date_s;
  alias date = date_s | sql;
  scalar jsonb_s;
  alias jsonb = jsonb_s | sql;
  scalar json_s;
  alias json = json_s | sql;
  scalar integer_s extends int64;
  alias integer = integer_s | sql;
  scalar bigint_s extends int64;
  alias bigint = bigint_s | sql;
  scalar smallint_s extends int64;
  alias smallint = smallint_s | sql;
  scalar numeric_s extends float64;
  alias numeric = numeric_s | sql;
  scalar float8_s extends float64;
  alias float8 = float8_s | sql;
  scalar boolean_s extends TypeSpec.boolean;
  alias boolean = boolean_s | sql;
  scalar bytea_s;
  alias bytea = bytea_s | sql;
  scalar inet_s extends string;
  alias inet = inet_s | sql;
  scalar trigger;   // fn return marker only — never defaulted, no alias
}
