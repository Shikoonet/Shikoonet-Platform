-- 0009 — name the panel software we actually talk to.
--
-- Every production panel was imported as kind='marzban'. None of them is
-- Marzban. Mirzabot has no `pasarguard` type, so it stores the admin's choice
-- under the Marzban name and keeps the truth in a second column
-- (legacy/mirzabot-php/admin.php:749-750):
--
--     $version_panel = $userdata['type'] == "pasarguard" ? "1" : "0";
--     $userdata['type'] = $userdata['type'] == "pasarguard" ? "marzban" : ...;
--
-- All five live rows are version_panel='1', and their URL is literally
-- `pasargad.4g3.uk`. That is also why Marzban.php:229 sends them `group_ids`
-- and `proxy_settings` — the field names PasarGuard uses — rather than
-- `inbounds` and `proxies`.
--
-- 'marzban' stays in the list. A classic Marzban panel is a real thing; it
-- simply has no adapter, so `adapterFor` drops it to manual and a person
-- finishes the order. That is the safe direction. The unsafe direction was the
-- status quo, where such a panel would have been handed PasarGuard field names
-- and dropped them without a word.
--
-- A new file rather than an edit to 0002: CI rebuilds from scratch and would go
-- green either way, while every existing local volume would silently keep the
-- old constraint and reject the insert.

BEGIN;

ALTER TABLE provisioning_providers
  DROP CONSTRAINT provisioning_providers_kind_check,
  ADD  CONSTRAINT provisioning_providers_kind_check CHECK (kind IN (
    'marzban','pasarguard','marzneshin','hiddify','xui','wireguard',
    'ai_account','spotify','manual'));

COMMIT;
