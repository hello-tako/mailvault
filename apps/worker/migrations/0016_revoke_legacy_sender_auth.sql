-- Raw MIME Authentication-Results did not establish receiver-verified provenance.
-- Revoke every stored inbound verdict/evidence record created under that assumption.
UPDATE messages
SET auth_verdict = 'UNVERIFIED',
    auth_json = NULL
WHERE direction = 'IN';
