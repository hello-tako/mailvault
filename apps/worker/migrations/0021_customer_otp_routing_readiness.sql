-- Routing readiness is separate from provider-mail receipt classification.
-- This timestamp is written only after a live delivery-path verification proves
-- Email Routing and the MailVault catch-all are active for the domain.
ALTER TABLE domains ADD COLUMN routing_verified_at TEXT;
CREATE INDEX idx_domains_routing_verified_at ON domains(routing_verified_at);
