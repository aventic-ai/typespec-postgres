// Shadow prelude: minimal stand-ins for platform-owned surfaces the spec's
// objects reference. Signature-compatible stubs; never compared.
export const prelude = (db) => `
-- Supabase installs extensions outside public, reachable via search_path.
CREATE SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
ALTER DATABASE ${db} SET search_path = public, extensions;
SET search_path = public, extensions;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
CREATE TABLE auth.users (id uuid PRIMARY KEY);

CREATE SCHEMA storage;
CREATE TABLE storage.objects (
  id uuid, bucket_id text, name text, owner uuid,
  created_at timestamptz, updated_at timestamptz, last_accessed_at timestamptz,
  metadata jsonb, path_tokens text[], version text, owner_id text, user_metadata jsonb
);
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql
  AS 'SELECT string_to_array(name, ''/'')';
CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql
  AS 'SELECT name';
CREATE FUNCTION storage.extension(name text) RETURNS text LANGUAGE sql
  AS 'SELECT name';

CREATE SCHEMA realtime;
CREATE TABLE realtime.messages (
  topic text, extension text, payload jsonb, event text, private boolean,
  updated_at timestamp, inserted_at timestamp, id uuid, binary_payload bytea
);
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
`;
