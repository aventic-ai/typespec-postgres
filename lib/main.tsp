import "./index.js";

using TypeSpec.Reflection;

// Table-fact decorators (grammar rules 6-9, 17)
extern dec rls(target: Model);
extern dec external(target: Model);
extern dec pk(target: Model, cols: valueof string, name?: valueof string);
extern dec partition_by(target: Model, spec: valueof string);
extern dec unmanaged_partitions(target: Model, pattern: valueof string);
extern dec check(target: Model | ModelProperty, expr: valueof string, name?: valueof string);
extern dec constraint(target: Model, name: valueof string, def: valueof string);
extern dec default(target: ModelProperty, sql: valueof string);
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
extern dec arg_default(target: ModelProperty, sql: valueof string);

// Cron
extern dec schedule(target: Operation, cron: valueof string);
extern dec command(target: Operation, sql: valueof string);

namespace `public` {
  scalar uuid extends string;
  scalar text extends string;
  scalar timestamptz;
  scalar timestamp;
  scalar date;
  scalar jsonb;
  scalar json;
  scalar integer extends int64;
  scalar bigint extends int64;
  scalar smallint extends int64;
  scalar numeric extends float64;
  scalar float8 extends float64;
  scalar boolean extends TypeSpec.boolean;
  scalar bytea;
  scalar inet extends string;
  scalar trigger;
}
